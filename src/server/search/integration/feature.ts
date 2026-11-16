import type { SearchPersistence } from "../storage/persistence.js";
import { searchSourceDescriptor } from "../storage/registry.js";

import { VectorSealStore } from "../providers/vector-seal.js";
import { join, resolve } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { SearchSource, ApprovedKnowledgeSource } from "../ports.js";
import type { SearchScope, SearchMode } from "../../../shared/search/contracts.js";
import { SearchError } from "../../../shared/search/contracts.js";
import { searchId, searchRecord, searchText, DEFAULT_SEARCH_SETTINGS } from "../../../shared/search/validation.js";
import { SearchAudits } from "../storage/audits.js";
import { SearchAuditRunner } from "../audit/runner.js";
import { SearchJobs } from "../storage/jobs.js";
import { openSearchDatabase } from "../storage/database.js";
import { SearchSourceRegistry } from "../storage/registry.js";
import { AnalyzerStore } from "../analyzers/store.js";
import { LocalTextIndex } from "../providers/local.js";
import { SearchIndexer } from "../indexer.js";
import { ContentSearch } from "../service.js";
import { knowledgeReason, pathSelected } from "../snippets.js";
import { searchConfiguration } from "./config.js";
import { SearchConnections } from "./connections.js";
import { searchRuntime } from "./runtime.js";
import { searchRoutes } from "./routes.js";
import { reviewAnalyzers } from "./analyzer-import.js";
import { SearchEmbeddingService } from "../embeddings/service.js";
import { SearchProjectPolicies } from "../storage/project-policies.js";
import { searchReadScope } from "../content-selection.js";
import { SearchIndexResources } from "../storage/resources.js";
import { createVectorMaintenance } from "./vector-maintenance.js";
export async function createSearchFeature(options: {
  stateRoot: string;
  storage?: SearchPersistence;
  appRoot: string;
  content: SearchSource;
  knowledge?: ApprovedKnowledgeSource;
  indexContent?: SearchSource;
  indexKnowledge?: ApprovedKnowledgeSource;
  owner(context: RouteContext): string;
  administrator(context: RouteContext, allowlist: string[]): boolean;
  report(error: unknown): void;
  env?: NodeJS.ProcessEnv;
}) {
  const env = options.env ?? process.env,
    config = searchConfiguration(options.stateRoot, env),
    db = options.storage ? null : openSearchDatabase(join(options.stateRoot, "data", "search.sqlite"));
  try {
    const indexRoot = resolve(env.PANDA_FORCE_SEARCH_ROOT || join(options.stateRoot, "search")),
      sources = options.storage?.sources ?? new SearchSourceRegistry(db!),
      jobs = options.storage?.jobs ?? new SearchJobs(db!),
      policies = options.storage?.policies ?? new SearchProjectPolicies(db!),
      analyzers =
        options.storage?.analyzers ?? new AnalyzerStore(db!, join(options.stateRoot, "plugins", "search-analyzers"));
    await analyzers.initialize();
    const connections =
        options.storage?.connections ??
        new SearchConnections(db!, config.connections, options.stateRoot, config.knowledge),
      instance =
        options.storage?.instance ??
        db!
          .query<
            {
              value: string;
            },
            []
          >("SELECT value FROM search_meta WHERE id='instance'")
          .get()!.value;
    const resources = options.storage?.resources ?? new SearchIndexResources(db!),
      seals = new VectorSealStore(join(indexRoot, "vectors"));
    const embeddings = new SearchEmbeddingService(
        join(options.stateRoot, "data", "embeddings.sqlite"),
        join(indexRoot, "embeddings"),
        instance,
        config.embedding,
        options.report,
        Date.now,
        options.storage?.embeddingBudget,
      ),
      local = new LocalTextIndex(
        join(indexRoot, "text"),
        join(options.appRoot, "src", "server", "search", "worker-entry.ts"),
      ),
      runtime = searchRuntime(
        sources,
        connections,
        analyzers,
        local,
        instance,
        seals,
        embeddings,
        resources,
        options.report,
      );
    const indexedContent = options.indexContent ?? options.content,
      indexedKnowledge = options.indexKnowledge ?? options.knowledge,
      indexer = new SearchIndexer(jobs, indexedContent, runtime, options.report, indexedKnowledge),
      content = new ContentSearch(jobs, options.content, runtime, () => indexer.kick(), options.knowledge),
      inflight = new Map<string, number>(),
      audits = options.storage?.audits ?? new SearchAudits(db!),
      auditRunner = new SearchAuditRunner(
        { ledger: jobs, content: indexedContent, runtime, knowledge: indexedKnowledge },
        audits,
        () => indexer.kick(),
        options.report,
      );
    const admin = (ctx: RouteContext) => {
      if (!options.administrator(ctx, config.administrators)) throw new SearchError("forbidden", 403);
    };
    const maintenance = createVectorMaintenance({
      db,
      scans: options.storage?.scans,
      scopes: options.storage ? async () => await jobs.all() : undefined,
      connections,
      sources,
      instance,
      resources,
      seals,
      admin,
      report: options.report,
    });
    const scope = async (ctx: RouteContext, project: unknown, source?: unknown): Promise<SearchScope> => ({
      owner: options.owner(ctx),
      project: searchId(project),
      source: source === undefined ? (await sources.binding()).source! : searchId(source),
    });
    const query = async (owner: string, input: unknown, test: boolean, signal: AbortSignal) => {
      const p = searchRecord(
          input,
          test ? ["project", "source", "query", "mode", "cursor"] : ["project", "query", "mode", "cursor"],
        ),
        binding = await sources.binding(),
        s: SearchScope = { owner, project: searchId(p.project), source: test ? searchId(p.source) : binding.source! },
        count = inflight.get(s.owner) ?? 0;
      if (count >= 2) throw new SearchError("limit", 429);
      inflight.set(s.owner, count + 1);
      try {
        const result = await content.query(
          s,
          searchText(p.query),
          p.mode === undefined ? "text" : (p.mode as SearchMode),
          p.cursor === undefined ? undefined : searchText(p.cursor, 500),
          signal,
        );
        if (!test && (await sources.binding()).revision !== binding.revision)
          throw new SearchError("indexChanged", 409);
        return result;
      } finally {
        const left = (inflight.get(s.owner) ?? 1) - 1;
        if (left > 0) inflight.set(s.owner, left);
        else inflight.delete(s.owner);
      }
    };
    const readStatus = async (owner: string, project: unknown, source?: unknown) => {
      const s: SearchScope = {
        owner,
        project: searchId(project),
        source: source === undefined ? (await sources.binding()).source! : searchId(source),
      };
      await options.content.authorize(s);
      const sourceDefinition = await sources.get(s.source);
      return {
        ...(await jobs.view(await jobs.get(s))),
        projectPolicy: await policies.summary(s),
        source: s.source,
        audit: await audits.view(await jobs.get(s), sourceDefinition.revision),
        ...(sourceDefinition.knowledge ? { embedding: await embeddings.usageAsync(owner) } : {}),
      };
    };
    const api = {
      ...maintenance.api,
      async previousSettings(ctx: RouteContext, project: unknown, source: unknown, offset: unknown) {
        admin(ctx);
        const s = await scope(ctx, project, source);
        await options.content.authorize(s);
        const page = await policies.page(s, Number(offset));
        await options.content.authorize(s);
        return page;
      },
      async catalog(ctx: RouteContext) {
        const administrator = options.administrator(ctx, config.administrators);
        return {
          administrator,
          binding: await sources.binding(),
          sources: administrator ? await sources.list() : [],
          connections: administrator ? await connections.list() : [],
          knowledge: administrator ? await connections.knowledge() : [],
          analyzers: administrator ? await analyzers.list() : [],
        };
      },
      async query(ctx: RouteContext, input: unknown, test = false, signal = new AbortController().signal) {
        if (test) admin(ctx);
        return query(options.owner(ctx), input, test, signal);
      },
      async status(ctx: RouteContext, project: unknown, source?: unknown) {
        if (source !== undefined) admin(ctx);
        return readStatus(options.owner(ctx), project, source);
      },
      async audit(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["project", "source"]),
          s = await scope(ctx, p.project, p.source);
        await options.content.authorize(s);
        const row = await jobs.get(s);
        if (!row) throw new SearchError("notFound", 404);
        if (!(await jobs.settings(row)).enabled || !(await auditRunner.request(s)))
          throw new SearchError("notReady", 409);
        return await audits.view(await jobs.get(s), (await sources.get(s.source)).revision);
      },
      async configure(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["project", "source", "settings", "revision"]);
        if (!Number.isSafeInteger(p.revision)) throw new SearchError("invalidInput");
        if (
          p.settings &&
          typeof p.settings === "object" &&
          "vector" in p.settings &&
          p.settings.vector &&
          !options.knowledge
        )
          throw new SearchError("configuration", 409);
        return await jobs.view(
          await content.configure(await scope(ctx, p.project, p.source), p.settings, Number(p.revision)),
        );
      },
      async retry(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["project", "source"]),
          s = await scope(ctx, p.project, p.source);
        await options.content.authorize(s);
        await jobs.rebuild(s);
        indexer.kick();
        return await jobs.view(await jobs.get(s));
      },
      async preview(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["project", "source"]),
          s = await scope(ctx, p.project, p.source),
          row = await jobs.get(s),
          settings = row ? await jobs.settings(row) : DEFAULT_SEARCH_SETTINGS,
          selected = searchReadScope(s, settings),
          snapshot = await (options.content.metadata
            ? options.content.metadata(selected)
            : options.content.snapshot(selected));
        return {
          commit: snapshot.commit,
          total: snapshot.documents.length,
          documents: snapshot.documents.slice(0, 1000).map((d) => ({
            id: d.id,
            title: d.title,
            path: d.path,
            kind: d.kind ?? "document",
            selected: settings.enabled && settings.fulltext && pathSelected(d.path, settings.include, settings.exclude),
            ancestors: d.ancestors,
            reason: d.kind && d.kind !== "document" ? "manual" : knowledgeReason(d, settings.knowledge),
            eligible:
              (!d.kind || d.kind === "document") &&
              settings.enabled &&
              settings.vector &&
              pathSelected(d.path, settings.include, settings.exclude),
          })),
          truncated: snapshot.documents.length > 1000,
        };
      },
      async manual(ctx: RouteContext, input: unknown) {
        admin(ctx);
        if (!options.knowledge) throw new SearchError("configuration", 409);
        const p = searchRecord(input, ["project", "source", "document", "enabled", "revision"]),
          s = await scope(ctx, p.project, p.source),
          id = searchId(p.document);
        if (typeof p.enabled !== "boolean" || !Number.isSafeInteger(p.revision)) throw new SearchError("invalidInput");
        if (!(await options.content.current(searchReadScope(s, DEFAULT_SEARCH_SETTINGS), [id])).length)
          throw new SearchError("notFound", 404);
        const row = await jobs.get(s),
          settings = structuredClone(row ? await jobs.settings(row) : DEFAULT_SEARCH_SETTINGS);
        settings.enabled = true;
        settings.vector = true;
        if (p.enabled) {
          settings.knowledge.documents = [...new Set([...settings.knowledge.documents, id])];
          settings.knowledge.exclude = settings.knowledge.exclude.filter((x) => x !== id);
        } else {
          settings.knowledge.documents = settings.knowledge.documents.filter((x) => x !== id);
          settings.knowledge.exclude = [...new Set([...settings.knowledge.exclude, id])];
        }
        return await jobs.view(await content.configure(s, settings, Number(p.revision)));
      },
      async saveSource(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["source", "revision"]);
        if (!Number.isSafeInteger(p.revision)) throw new SearchError("invalidInput");
        await runtime.available(searchSourceDescriptor(p.source, Number(p.revision)));
        const result = await sources.save(p.source, Number(p.revision), () => {});
        indexer.kick();
        return result;
      },
      async activate(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["source", "revision", "sourceRevision"]),
          source = await sources.get(searchId(p.source));
        if (
          !Number.isSafeInteger(p.revision) ||
          !Number.isSafeInteger(p.sourceRevision) ||
          !(await (await runtime.text(source)).health())
        )
          throw new SearchError("configuration", 409);
        if (source.knowledge && !(await (await runtime.vectors(source))?.health()))
          throw new SearchError("configuration", 409);
        if (source.kind === "elasticsearch" && !(await jobs.hasReadyIndex(source.id, source.revision)))
          throw new SearchError("notReady", 409);
        return await sources.activate(source.id, Number(p.revision), Number(p.sourceRevision));
      },
      async health(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["source"]),
          source = await sources.get(searchId(p.source));
        return {
          text: await (await runtime.text(source)).health(),
          knowledge: source.knowledge ? await (await runtime.vectors(source))?.health() : null,
        };
      },
      async addConnection(ctx: RouteContext, input: unknown) {
        admin(ctx);
        return await connections.add(input);
      },
      async addKnowledge(ctx: RouteContext, input: unknown) {
        admin(ctx);
        return await connections.addKnowledge(input);
      },
      async review(ctx: RouteContext, input: unknown, signal: AbortSignal) {
        admin(ctx);
        return reviewAnalyzers(analyzers, options.owner(ctx), input, signal);
      },
      async install(ctx: RouteContext, input: unknown) {
        admin(ctx);
        const p = searchRecord(input, ["digest"]);
        return await analyzers.install(options.owner(ctx), searchText(p.digest, 64));
      },
      async export(ctx: RouteContext, reference: string) {
        admin(ctx);
        return await analyzers.export(searchText(reference, 180));
      },
    };
    return {
      api,
      query: (owner: string, input: unknown, signal: AbortSignal) => query(owner, input, false, signal),
      status: (owner: string, project: unknown) => readStatus(owner, project),
      routes: searchRoutes(api),
      start: () => {
        maintenance.start();
        indexer.start();
        auditRunner.start();
      },
      async changed(project: string, owner?: string) {
        for (const row of await jobs.all())
          if (
            row.project === project &&
            (project !== "personal" || !owner || row.owner === owner) &&
            row.state === "ready" &&
            (await indexedContent.head(searchReadScope(row, await jobs.settings(row)))) !== row.commitId
          )
            await jobs.wake(row.key);
        indexer.kick();
      },
      async close() {
        await maintenance.close();
        await auditRunner.close();
        await indexer.close();
        await embeddings.close();
        await local.close();
        db?.close();
      },
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}
export type SearchApi = Awaited<ReturnType<typeof createSearchFeature>>["api"];
