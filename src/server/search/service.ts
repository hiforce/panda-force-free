import type { MetadataStore } from "../knowledge/metadata-ports.js";
import { createHash } from "node:crypto";
import { DEFAULT_SEARCH_SETTINGS, searchText, searchSettings } from "../../shared/search/validation.js";
import { SEARCH_LIMITS, SearchError, type SearchScope, type SearchMode } from "../../shared/search/contracts.js";
import type { SearchSource, ApprovedKnowledgeSource } from "./ports.js";
import type { SearchLedger } from "./state.js";
import type { SearchRuntime } from "./indexer.js";
import { IndexIntegrityError } from "./integrity.js";
import { querySearchCandidates } from "./candidates.js";
import { hydrateSearchPage } from "./hydrate.js";
import { searchReadScope } from "./content-selection.js";
/** User requests receive current authorized content; provider results grant no access or presentation authority. */
export class ContentSearch {
  constructor(
    private ledger: MetadataStore<SearchLedger>,
    private content: SearchSource,
    private runtime: MetadataStore<SearchRuntime>,
    private kick: () => void,
    private knowledge?: ApprovedKnowledgeSource,
  ) {}
  async configure(scope: SearchScope, value: unknown, revision: number) {
    await this.content.authorize(scope);
    const settings = searchSettings(value),
      source = await this.runtime.source(scope.source);
    await this.runtime.analyzer(settings.analyzer);
    if (settings.vector) {
      if (!(await this.runtime.vectors(source)) || !this.knowledge) throw new SearchError("configuration", 409);
      await this.knowledge.head(scope);
    }
    await this.content.authorize(scope);
    const row = await this.ledger.configure(scope, settings, revision);
    this.kick();
    return row;
  }
  async query(
    scope: SearchScope,
    input: string,
    mode: SearchMode = "text",
    cursor?: string,
    signal = new AbortController().signal,
  ) {
    // A completed background rebuild may replace a valid first-page generation. Refresh once; cursors keep their fence.
    for (let attempt = 0; attempt < (cursor ? 1 : 2); attempt++) {
      const result = await this.read(scope, input, mode, cursor, signal);
      if (result) return result;
    }
    throw new SearchError("indexChanged", 409);
  }
  private async read(
    scope: SearchScope,
    input: string,
    mode: SearchMode,
    cursor: string | undefined,
    signal: AbortSignal,
  ) {
    const query = searchText(input, SEARCH_LIMITS.query).trim();
    if (!["text", "semantic", "hybrid"].includes(mode)) throw new SearchError("invalidInput");
    signal.throwIfAborted();
    await this.content.authorize(scope);
    const source = await this.runtime.source(scope.source);
    if (!source.enabled) throw new SearchError("configuration", 409);
    let row = await this.ledger.get(scope);
    if (!row && query) {
      if (mode !== "text") throw new SearchError("configuration", 409);
      row = await this.ledger.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
      this.kick();
    }
    if (!row || !query)
      return { hits: [], nextCursor: null, state: row?.state ?? "idle", failure: row?.failure ?? null };
    const settings = await this.ledger.settings(row),
      active = await this.ledger.active(row);
    if (!settings.enabled)
      return {
        hits: [],
        nextCursor: null,
        state: row.state === "needsReview" ? "needsReview" : "disabled",
        failure: null,
      };
    if (
      (mode !== "semantic" && !settings.fulltext) ||
      (mode !== "text" && (!settings.vector || !this.knowledge || !(await this.runtime.vectors(source))))
    )
      throw new SearchError("configuration", 409);
    if (!active) {
      if (row.state === "queued") this.kick();
      return { hits: [], nextCursor: null, state: row.state, failure: row.failure };
    }
    if (active.invalidated) {
      this.kick();
      return { hits: [], nextCursor: null, state: row.state, failure: row.failure };
    }
    if ((mode !== "semantic" && !active.text) || (mode !== "text" && !active.vector)) {
      if (!(await this.ledger.invalidate(row.key, row))) throw new SearchError("indexChanged", 409);
      this.kick();
      return { hits: [], nextCursor: null, state: "queued", failure: null };
    }
    if (
      active.sourceRevision !== source.revision ||
      (mode !== "semantic" && active.textFingerprint !== (await this.runtime.text(source)).fingerprint()) ||
      (mode !== "text" && active.embedding !== (await this.runtime.vectors(source))!.fingerprint())
    ) {
      if (row.state === "failed") return { hits: [], nextCursor: null, state: row.state, failure: row.failure };
      await this.ledger.wake(row.key);
      this.kick();
      return { hits: [], nextCursor: null, state: "queued", failure: null };
    }
    const analyzer = await this.runtime.analyzer(active.analyzer),
      head = await this.content.head(searchReadScope(scope, settings)),
      knowledgeHead = mode === "text" ? null : await this.knowledge!.head(scope),
      binding = createHash("sha256")
        .update(JSON.stringify([scope.owner, row.key, row.active, row.revision, head, knowledgeHead, query, mode]))
        .digest("hex");
    let offset = 0;
    if (cursor) {
      try {
        if (cursor.length > 500) throw Error();
        const p = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          p.binding !== binding ||
          !Number.isSafeInteger(p.offset) ||
          p.offset < 0 ||
          p.offset > SEARCH_LIMITS.candidates
        )
          throw Error();
        offset = p.offset;
      } catch {
        throw new SearchError("indexChanged", 409);
      }
    }
    let page;
    try {
      const candidates = await querySearchCandidates({
        scope,
        active,
        runtime: this.runtime,
        analyzer,
        query,
        mode,
        fulltext: settings.fulltext,
        vector: settings.vector,
        knowledge: this.knowledge,
        signal,
      });
      page = {
        ...(await hydrateSearchPage({
          content: this.content,
          knowledge: this.knowledge,
          scope,
          settings,
          candidates,
          offset,
          query,
          analyzer,
          signal,
        })),
        total: candidates.length,
      };
    } catch (error) {
      if (!(error instanceof IndexIntegrityError)) throw error;
      await this.content.authorize(scope);
      if (!(await this.ledger.invalidate(row.key, row))) throw new SearchError("indexChanged", 409);
      this.kick();
      return { hits: [], nextCursor: null, state: "queued", failure: null };
    }
    await this.content.authorize(scope);
    signal.throwIfAborted();
    const latest = await this.ledger.get(scope);
    if (
      !latest ||
      !(await this.ledger.settings(latest)).enabled ||
      latest.revision !== row.revision ||
      (await this.runtime.source(scope.source)).revision !== source.revision ||
      (await this.content.head(searchReadScope(scope, settings))) !== head ||
      (mode !== "text" && (await this.knowledge!.head(scope)) !== knowledgeHead)
    )
      throw new SearchError("indexChanged", 409);
    if (latest.active !== row.active) return null;
    const stale =
      page.stale ||
      active.settingsRevision !== row.revision ||
      head !== row.commitId ||
      (mode !== "text" && knowledgeHead !== active.knowledgeCommit);
    if (stale && row.state !== "failed") {
      await this.ledger.wake(row.key);
      this.kick();
    }
    return {
      hits: page.hits,
      nextCursor:
        page.scanned < page.total
          ? Buffer.from(JSON.stringify({ binding, offset: page.scanned })).toString("base64url")
          : null,
      state: stale && row.state !== "failed" ? "queued" : row.state,
      failure: row.failure,
    };
  }
}
