import { expect, test } from "bun:test";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { SearchIndexer, type SearchRuntime } from "../../src/server/search/indexer.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { generationName } from "../../src/server/search/providers/local.js";
import { approvedSearchKnowledge } from "../support/search-knowledge-fixture.js";
import type { IndexReference, SearchSource } from "../../src/server/search/ports.js";
import type { VectorIndexProvider } from "../../src/server/search/ports.js";
import type { SearchDocument } from "../../src/shared/search/contracts.js";

async function ready(jobs: SearchJobs, scope: Parameters<SearchJobs["get"]>[0]) {
  const until = Date.now() + 5000;
  while (jobs.get(scope)?.state !== "ready") {
    if (Date.now() > until) throw Error("Generation failed to become ready");
    await Bun.sleep(5);
  }
}
test("unchanged approved payload reuses vectors across source/head changes and legacy retirement", async () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db, () => now),
    registry = new SearchSourceRegistry(db),
    scope = { source: "builtin", owner: "owner", project: "project" },
    document: SearchDocument = {
      id: "original",
      version: "v1",
      title: "Original",
      text: "Reviewed content",
      locale: "en",
      path: "original.md",
      ancestors: [],
      updatedAt: 1,
    },
    approved = approvedSearchKnowledge([document]),
    settings = {
      ...DEFAULT_SEARCH_SETTINGS,
      enabled: true,
      vector: true,
      knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, mode: "project" as const },
    },
    droppedText: string[] = [],
    droppedVectors: string[] = [],
    errors: unknown[] = [];
  let now = 1000000,
    head = "saved1",
    knowledgeHead = "approved1",
    builds = 0,
    textBuilds = 0,
    fault = false;
  const content: SearchSource = {
      authorize: async () => {},
      head: async () => head,
      current: async () => [document],
      snapshot: async () => ({
        commit: head,
        documents: [document, { ...document, id: "unrelated", path: "other.md", text: head }],
      }),
    },
    runtime: SearchRuntime = {
      source: (id) => registry.get(id),
      generation: generationName,
      analyzer: async () => builtinAnalyzer(),
      text: () => ({
        id: "local",
        fingerprint: () => "text",
        health: async () => true,
        audit: async () => ({ count: 2, checks: [] }),
        query: async () => [],
        build: async (name) => {
          textBuilds++;
          if (fault) {
            fault = false;
            head = "saved-after-build";
          }
          return { name, provider: "local" };
        },
        drop: async (ref) => {
          droppedText.push(ref.name);
        },
      }),
      vectors: () => ({
        fingerprint: () => "vectors",
        health: async () => true,
        query: async () => [],
        build: async (name) => {
          builds++;
          return { name, provider: "milvus" };
        },
        drop: async (ref) => {
          droppedVectors.push(ref.name);
        },
      }),
    },
    indexer = new SearchIndexer(jobs, content, runtime, (error) => errors.push(error), {
      head: async () => knowledgeHead,
      current: async () => [approved],
      snapshot: async () => ({ commit: knowledgeHead, records: [approved] }),
    });
  try {
    jobs.configure(scope, settings, 0);
    indexer.start();
    await ready(jobs, scope);
    const initial = jobs.active(jobs.get(scope)!)!,
      vector = initial.vector!;
    head = "saved2";
    jobs.wake(jobs.get(scope)!.key);
    indexer.kick();
    await ready(jobs, scope);
    expect(jobs.active(jobs.get(scope)!)!.vector).toEqual(vector);
    expect(builds).toBe(1);
    expect(textBuilds).toBe(2);
    const retired = JSON.parse(
      db.query<{ descriptor: string }, []>("SELECT descriptor FROM search_retired LIMIT 1").get()!.descriptor,
    );
    expect(retired.vector).toBeNull();
    db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,0)").run(JSON.stringify(initial));
    now += 300001;
    await indexer.reconcile();
    expect(droppedVectors).toEqual([]);
    expect(droppedText).toContain(initial.text!.name);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM search_retired").get()!.n).toBe(0);
    knowledgeHead = "approved2";
    jobs.wake(jobs.get(scope)!.key);
    indexer.kick();
    await ready(jobs, scope);
    expect(builds).toBe(1);
    expect(jobs.active(jobs.get(scope)!)!.knowledgeCommit).toBe("approved2");
    fault = true;
    head = "saved3";
    jobs.wake(jobs.get(scope)!.key);
    indexer.kick();
    await ready(jobs, scope);
    expect(builds).toBe(1);
    expect(droppedVectors).toEqual([]);
    expect(errors).toMatchObject([{ code: "conflict" }]);
    expect(jobs.get(scope)!.commitId).toBe("saved-after-build");
    jobs.configure(
      scope,
      { ...settings, knowledge: { ...settings.knowledge, exclude: [document.id] } },
      jobs.get(scope)!.revision,
    );
    indexer.kick();
    await ready(jobs, scope);
    expect(builds).toBe(2);
    now += 300001;
    await indexer.reconcile();
    expect(droppedVectors).toEqual([vector.name]);
  } finally {
    await indexer.close();
    db.close();
  }
});
test("retirement protects a component referenced by a different active scope", async () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    registry = new SearchSourceRegistry(db),
    scope = { source: "builtin", owner: "owner", project: "other-project" },
    ref: IndexReference = { name: "a".repeat(64), provider: "milvus" };
  let drops = 0;
  try {
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    const row = jobs.claim()!;
    const active = {
      text: null,
      vector: ref,
      source: registry.get("builtin"),
      sourceRevision: 1,
      settingsRevision: row.revision,
      embedding: "vectors",
      textFingerprint: null,
      analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
    };
    jobs.complete(row, active, "saved", 0);
    db.query("INSERT INTO search_retired(descriptor,due) VALUES(?,0)").run(JSON.stringify(active));
    const { retireSearchGenerations } = await import("../../src/server/search/retirement.js");
    await retireSearchGenerations(
      jobs,
      {
        text: () => {
          throw Error("Text cleanup was not expected");
        },
        vectors: () => ({
          fingerprint: () => "vectors",
          health: async () => true,
          query: async () => [],
          build: async () => {
            throw Error("Build was not expected");
          },
          drop: async () => {
            drops++;
          },
        }),
      },
      0,
      () => {},
    );
    expect(drops).toBe(0);
    expect(jobs.retired()).toEqual([]);
  } finally {
    db.close();
  }
});
test("failed activation cleans each new resource through its original provider even if another cleanup fails", async () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    scope = { source: "builtin", owner: "owner", project: "project" },
    doc: SearchDocument = {
      id: "source",
      title: "Source",
      text: "Reviewed",
      version: "v1",
      locale: "en",
      path: "source.md",
      ancestors: [],
      updatedAt: 1,
    },
    approved = approvedSearchKnowledge([doc]),
    droppedA: string[] = [],
    droppedB: string[] = [],
    errors: unknown[] = [];
  let replaced = false,
    current: VectorIndexProvider;
  const b: VectorIndexProvider = {
      fingerprint: () => "vector-b",
      health: async () => true,
      query: async () => [],
      build: async (name) => ({ name, provider: "milvus" }),
      drop: async (ref) => {
        droppedB.push(ref.name);
      },
    },
    a: VectorIndexProvider = {
      ...b,
      fingerprint: () => "vector-a",
      build: async (name) => {
        if (!replaced) {
          replaced = true;
          current = b;
          sources.save(
            { id: "builtin", name: "Updated", kind: "local", connection: null, knowledge: null, enabled: true },
            1,
            () => {},
          );
        }
        return { name, provider: "milvus" };
      },
      drop: async (ref) => {
        droppedA.push(ref.name);
      },
    };
  current = a;
  const indexer = new SearchIndexer(
    jobs,
    {
      authorize: async () => {},
      head: async () => "saved",
      snapshot: async () => ({ commit: "saved", documents: [doc] }),
      current: async () => [doc],
    },
    {
      source: (id) => sources.get(id),
      generation: generationName,
      analyzer: async () => builtinAnalyzer(),
      vectors: () => current,
      text: () => ({
        id: "local",
        fingerprint: () => "text",
        health: async () => true,
        query: async () => [],
        audit: async () => ({ count: 1, checks: [] }),
        build: async (name) => ({ name, provider: "local" }),
        drop: async () => {
          throw Error("Text cleanup failed");
        },
      }),
    },
    (error) => errors.push(error),
    {
      head: async () => "approved",
      current: async () => [approved],
      snapshot: async () => ({ commit: "approved", records: [approved] }),
    },
  );
  try {
    jobs.configure(
      scope,
      {
        ...DEFAULT_SEARCH_SETTINGS,
        enabled: true,
        vector: true,
        knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, mode: "project" },
      },
      0,
    );
    indexer.start();
    await ready(jobs, scope);
    expect(droppedA).toHaveLength(1);
    expect(droppedB).toEqual([]);
    expect(jobs.active(jobs.get(scope)!)!.embedding).toBe("vector-b");
    expect(errors.map((error) => (error instanceof Error ? error.message : "unknown"))).toContain(
      "Text cleanup failed",
    );
  } finally {
    await indexer.close();
    db.close();
  }
});
