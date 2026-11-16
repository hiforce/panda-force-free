import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndexer } from "../../src/server/search/indexer.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { LocalIndexEngine } from "../../src/server/search/providers/local-engine.js";
import { ElasticsearchIndex } from "../../src/server/search/providers/elasticsearch.js";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { connectionFingerprint } from "../../src/server/search/connection.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import { projectSearchText } from "../../src/server/search/providers/text-projection.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

test("retirement crosses supported local format upgrades and is not starved by retained foreign entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-retire-search-")),
    db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    provider = new LocalIndexEngine(root),
    errors: unknown[] = [];
  const indexer = new SearchIndexer(
    jobs,
    {
      authorize: async () => {},
      head: async () => "saved",
      snapshot: async () => ({ commit: "saved", documents: [] }),
      current: async () => [],
    },
    {
      source: (id) => sources.get(id),
      text: () => provider,
      vectors: () => null,
      analyzer: async () => builtinAnalyzer(),
      generation: () => "unused",
    },
    (error) => errors.push(error),
  );
  try {
    const ref = await provider.build("a".repeat(64), [], builtinAnalyzer(), new AbortController().signal),
      active = {
        text: ref,
        vector: null,
        source: sources.get("builtin"),
        sourceRevision: 1,
        settingsRevision: 1,
        embedding: null,
        analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
        textFingerprint: "minisearch/7.2.0/schema1",
      };
    for (let i = 0; i < 40; i++)
      db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,0)").run(
        JSON.stringify({ ...active, textFingerprint: "unknown-provider-namespace" }),
      );
    db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,0)").run(JSON.stringify(active));
    await indexer.reconcile();
    expect(await readFile(join(root, ref.name + ".json"))).toBeDefined();
    await indexer.reconcile();
    await expect(readFile(join(root, ref.name + ".json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM search_retired").get()!.n).toBe(40);
    expect(errors).toEqual([]);
  } finally {
    await indexer.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("ES legacy retirement requires the exact connection namespace and full application instance", () => {
  const connection = { id: "es", kind: "elasticsearch" as const, url: "http://example.invalid", prefix: "panda" },
    provider = new ElasticsearchIndex(new SearchHttp(connection), "one-instance", {
      project: async (document, analyzer) => projectSearchText(document, analyzer),
    }),
    old = connectionFingerprint(connection) + "/es-v1/one-instance";
  expect(provider.canRetire(old)).toBeTrue();
  expect(provider.canRetire(old.replace("one-instance", "other-instance"))).toBeFalse();
  expect(
    provider.canRetire(connectionFingerprint({ ...connection, prefix: "foreign" }) + "/es-v1/one-instance"),
  ).toBeFalse();
  expect(
    provider.canRetire(
      connectionFingerprint({ ...connection, url: "http://different.invalid" }) + "/es-v1/one-instance",
    ),
  ).toBeFalse();
  expect(provider.canRetire(old.replace("es-v1", "es-unknown"))).toBeFalse();
});
