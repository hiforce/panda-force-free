import type { MetadataStore } from "../knowledge/metadata-ports.js";
import { randomUUID } from "node:crypto";
import type { SearchSourceDefinition } from "../../shared/search/contracts.js";
import { SearchError } from "../../shared/search/contracts.js";
import type { SearchSource, ApprovedKnowledgeSource, SearchRuntime, IndexReference } from "./ports.js";
import type { ActiveSearchIndex, SearchLedger, SearchJobRow } from "./state.js";
import { pathSelected } from "./snippets.js";
import { knowledgeEligible, knowledgeVectorDocument, knowledgeVectorInput } from "./knowledge.js";
import { indexReferenceInUse } from "./references.js";
import { retireSearchGenerations } from "./retirement.js";
import { indexBuildProgress } from "./progress.js";
import { searchReadScope } from "./content-selection.js";
export type { SearchRuntime } from "./ports.js";
/** A bounded worker owns generation activation; durable leases and periodic reconciliation recover lost notifications. */
export class SearchIndexer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private reconciling: Promise<void> | null = null;
  private closing = false;
  private retiredCursor = 0;
  private controllers = new Set<AbortController>();
  constructor(
    private ledger: MetadataStore<SearchLedger>,
    private content: SearchSource,
    private runtime: MetadataStore<SearchRuntime>,
    private report: (error: unknown) => void,
    private knowledge?: ApprovedKnowledgeSource,
  ) {}
  start() {
    if (this.timer || this.closing) return;
    this.kick();
    this.timer = setInterval(() => {
      if (this.reconciling) return;
      this.reconciling = this.reconcile()
        .catch(this.report)
        .finally(() => {
          this.reconciling = null;
          this.kick();
        });
    }, 15000);
    this.timer.unref();
  }
  kick() {
    if (this.closing || this.running) return;
    this.running = Promise.allSettled([this.drain("local"), this.drain("elasticsearch")])
      .then((results) => {
        for (const result of results) if (result.status === "rejected") this.report(result.reason);
      })
      .catch(this.report)
      .finally(async () => {
        const pending = !this.closing && (await this.ledger.all()).some((row) => row.state === "queued");
        this.running = null;
        if (pending) this.kick();
      })
      .catch((error) => {
        this.running = null;
        this.report(error);
      });
  }
  async reconcile() {
    for (const row of await this.ledger.all()) {
      if (this.closing) return;
      if (row.state !== "ready") continue;
      try {
        const source = await this.runtime.source(row.source);
        if (!source.enabled) continue;
        const active = await this.ledger.active(row);
        if (!active) continue;
        const settings = await this.ledger.settings(row);
        if (
          active.invalidated ||
          source.revision !== active.sourceRevision ||
          (settings.fulltext && (await this.runtime.text(source)).fingerprint() !== active.textFingerprint) ||
          (settings.vector &&
            ((await this.runtime.vectors(source))?.fingerprint() !== active.embedding ||
              (await this.knowledge?.head(row)) !== active.knowledgeCommit)) ||
          (await this.content.head(searchReadScope(row, settings))) !== row.commitId
        )
          await this.ledger.wake(row.key);
      } catch (error) {
        this.report(error);
      }
    }
    if (this.closing) return;
    await this.ledger.reconcileReferences?.();
    this.retiredCursor = await retireSearchGenerations(this.ledger, this.runtime, this.retiredCursor, this.report);
  }
  private async drain(kind: SearchSourceDefinition["kind"]) {
    let row: SearchJobRow | null;
    while (!this.closing) {
      const sources: string[] = [];
      for (const id of new Set((await this.ledger.all()).map((row) => row.source))) {
        if ((await this.runtime.source(id)).kind === kind) sources.push(id);
      }
      row = await this.ledger.claim(sources);
      if (!row) return;
      if (this.closing) {
        await this.ledger.fail(row, "unavailable");
        return;
      }
      await this.build(row);
    }
  }
  private async build(row: SearchJobRow) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const lease = setInterval(async () => {
      try {
        if (!(await this.ledger.heartbeat(row))) controller.abort();
      } catch (error) {
        controller.abort();
        this.report(error);
      }
    }, 30000);
    lease.unref();
    let activated = false;
    const created: {
      kind: "text" | "vector";
      ref: IndexReference;
      drop: () => Promise<void>;
    }[] = [];
    const updates: Promise<unknown>[] = [];
    const updateProgress = (phase: "text" | "vector", completed: number, total: number) => {
      updates.push(Promise.resolve(this.ledger.progress?.(row, { phase, completed, total })).catch(this.report));
    };
    try {
      const source = await this.runtime.source(row.source),
        settings = await this.ledger.settings(row);
      if (!source.enabled || !settings.enabled) throw new SearchError("configuration", 409);
      const analyzer = await this.runtime.analyzer(settings.analyzer),
        text = settings.fulltext ? await this.runtime.text(source) : null,
        vectors = settings.vector ? await this.runtime.vectors(source, row) : null;
      if (settings.vector && (!vectors || !this.knowledge)) throw new SearchError("configuration", 409);
      const existing = await this.ledger.active(row);
      if (
        existing &&
        !existing.invalidated &&
        existing.sourceRevision === source.revision &&
        existing.settingsRevision === row.revision &&
        existing.textFingerprint === (text?.fingerprint() ?? null) &&
        existing.embedding === (vectors?.fingerprint() ?? null) &&
        (await this.content.head(searchReadScope(row, settings))) === row.commitId &&
        (!vectors || (await this.knowledge!.head(row)) === existing.knowledgeCommit)
      ) {
        activated = await this.ledger.complete(row, existing, row.commitId!, row.documentCount);
        return;
      }
      const readScope = searchReadScope(row, settings),
        snapshot = text
          ? await this.content.snapshot(readScope, controller.signal)
          : { commit: await this.content.head(readScope), documents: [] },
        documents = snapshot.documents.filter((d) => pathSelected(d.path, settings.include, settings.exclude)),
        name = await this.runtime.generation(row.key, randomUUID());
      const next: ActiveSearchIndex = {
        text: null,
        vector: null,
        analyzer: settings.analyzer,
        source,
        sourceRevision: source.revision,
        settingsRevision: row.revision,
        embedding: vectors?.fingerprint() ?? null,
        textFingerprint: text?.fingerprint() ?? null,
      };
      if (text) {
        await this.ledger.progress?.(row, { phase: "text", completed: 0, total: documents.length });
        const ref = await text.build(
          name,
          documents,
          analyzer,
          controller.signal,
          indexBuildProgress((completed, total) => updateProgress("text", completed, total)),
        );
        next.text = ref;
        created.push({ kind: "text", ref, drop: () => text.drop(ref) });
      }
      if (vectors) {
        await this.ledger.progress?.(row, { phase: "knowledge", completed: 0, total: null });
        const approved = await this.knowledge!.snapshot(row),
          selected = approved.records
            .filter((value) => knowledgeEligible(value, settings))
            .map(knowledgeVectorDocument);
        next.knowledgeCommit = approved.commit;
        next.vectorInput = knowledgeVectorInput(selected);
        if (
          existing?.vector &&
          !existing.invalidated &&
          existing.embedding === next.embedding &&
          existing.vectorInput === next.vectorInput
        ) {
          next.vector = existing.vector;
        } else {
          await this.ledger.progress?.(row, { phase: "vector", completed: 0, total: null });
          const ref = await vectors.build(
            name,
            selected,
            controller.signal,
            indexBuildProgress((completed, total) => updateProgress("vector", completed, total)),
          );
          next.vector = ref;
          created.push({ kind: "vector", ref, drop: () => vectors.drop(ref) });
        }
      }
      if (
        (await this.content.head(searchReadScope(row, settings))) !== snapshot.commit ||
        (vectors && (await this.knowledge!.head(row)) !== next.knowledgeCommit)
      ) {
        await this.ledger.wake(row.key, true);
        throw new SearchError("conflict", 409);
      }
      if (
        controller.signal.aborted ||
        this.closing ||
        (await this.runtime.source(row.source)).revision !== source.revision
      )
        throw new SearchError("conflict", 409);
      await this.ledger.progress?.(row, { phase: "activating", completed: 0, total: null });
      activated = await this.ledger.complete(row, next, snapshot.commit, documents.length);
    } catch (error) {
      await this.ledger.fail(row, error instanceof SearchError ? error.code : "unavailable");
      this.report(error);
    } finally {
      clearInterval(lease);
      if (!activated)
        for (const resource of created) {
          if (await indexReferenceInUse(this.ledger, resource.kind, resource.ref)) continue;
          try {
            await resource.drop();
          } catch (error) {
            this.report(error);
          }
        }
      await Promise.allSettled(updates);
      this.controllers.delete(controller);
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await this.running;
    await this.reconciling;
  }
}
