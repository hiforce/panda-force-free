import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { nativeKnowledgeFixture } from "../support/native-knowledge-fixture.js";
import { documentSearchSource } from "../../src/server/search/integration/content-source.js";
import { originalSearchSource } from "../../src/server/search/integration/original-source.js";
import { LocalTextIndex, generationName } from "../../src/server/search/providers/local.js";
import { SearchIndexer, type SearchRuntime } from "../../src/server/search/indexer.js";
import { ContentSearch } from "../../src/server/search/service.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { knowledgeEligible } from "../../src/server/search/knowledge.js";
import { savedSourceUrl } from "../../src/shared/content-sources/links.js";
import type { SearchVectorDocument, VectorIndexProvider } from "../../src/server/search/ports.js";

test.each([true, false])(
  "native approved knowledge pins citations and legacy kind defaults with full-text enabled=%s",
  async (fulltext) => {
    let built: SearchVectorDocument[] = [];
    const vectors: VectorIndexProvider = {
      fingerprint: () => "isolated-native-vectors",
      health: async () => true,
      storageHealth: async () => true,
      audit: async () => ({ count: built.length, checks: ["isolated-native-vectors"] }),
      build: async (name, records) => {
        built = structuredClone(records);
        return { name, provider: "milvus" };
      },
      drop: async () => {},
      query: async () =>
        built.map((record) => ({
          id: record.id,
          version: record.version,
          title: "Untrusted provider title",
          snippet: "Untrusted provider text",
          score: 1,
        })),
    };
    const f = await nativeKnowledgeFixture(),
      db = openSearchDatabase(":memory:"),
      jobs = new SearchJobs(db),
      registry = new SearchSourceRegistry(db),
      text = new LocalTextIndex(join(f.root, "indexes"), resolve("src/server/search/worker-entry.ts")),
      approved = f.reader(),
      content = originalSearchSource({
        originals: async () => f.app.originals,
        documents: documentSearchSource({
          project: f.app.queries,
          personal: async () => f.app.queries,
          authorizeProject: async (_owner, project) => f.app.projectContent.authorize(project),
        }),
      }),
      runtime: SearchRuntime = {
        source: (id) => registry.get(id),
        text: () => {
          if (!fulltext) throw Error("A disabled full-text provider is not available to this vector-only source");
          return text;
        },
        vectors: () => vectors,
        analyzer: async () => builtinAnalyzer(),
        generation: generationName,
      },
      errors: unknown[] = [],
      indexer = new SearchIndexer(jobs, content, runtime, (error) => errors.push(error), approved),
      search = new ContentSearch(jobs, content, runtime, () => indexer.kick(), approved),
      scope = { source: "builtin", ...f.scope },
      settings = {
        ...DEFAULT_SEARCH_SETTINGS,
        enabled: true,
        fulltext,
        vector: true,
        contentKinds: ["web" as const],
        knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, mode: "project" as const },
      };
    try {
      f.complete();
      const value = (await approved.current(f.scope, [f.record.id]))[0]!;
      expect(knowledgeEligible(value, { ...settings, contentKinds: undefined })).toBe(false);
      expect(knowledgeEligible(value, settings)).toBe(true);
      await search.configure(scope, settings, 0);
      indexer.start();
      const deadline = Date.now() + 20000;
      while (jobs.get(scope)?.state !== "ready") {
        if (Date.now() > deadline) throw Error("Native knowledge index did not become ready");
        await Bun.sleep(20);
      }
      expect(errors).toEqual([]);
      await indexer.close();
      expect(built.map((record) => record.id)).toEqual([f.record.id]);
      const mode = fulltext ? "hybrid" : "semantic",
        found = await search.query(scope, "Evidence", mode),
        hit = found.hits.find((item) => item.kind === "knowledge");
      expect(hit?.kind).toBe("knowledge");
      if (!hit || hit.kind !== "knowledge") throw Error("Approved knowledge result missing");
      expect(hit.title).toBe(f.record.draft.title);
      expect(hit.sources[0]!.url).toBe(savedSourceUrl(scope.project, f.saved.asset.id, "web", f.saved.asset.version));
      expect(new URL(hit.sources[0]!.url, "http://fixture").searchParams.get("assetVersion")).toBe(
        f.saved.asset.version,
      );
      await f.app.creations.setState(
        "alice",
        "project-1",
        f.saved.asset.id,
        f.saved.asset.version,
        "trashed",
        randomUUID(),
      );
      expect((await search.query(scope, "Evidence", mode)).hits).toEqual([]);
      expect(f.ledger.get(f.scope.owner, f.record.taskId).state).toBe("completed");
    } finally {
      await indexer.close();
      await text.close();
      db.close();
      await f.close();
    }
  },
  60000,
);
