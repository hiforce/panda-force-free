import { expect, test } from "bun:test";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { SearchIndexer } from "../../src/server/search/indexer.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import { generationName } from "../../src/server/search/providers/local.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { approvedSearchKnowledge } from "../support/search-knowledge-fixture.js";

function fixture(fulltext: boolean, sourceChanges = false) {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    scope = { source: "builtin", owner: "owner", project: "project" },
    document = {
      id: "original",
      version: "v1",
      title: "Original",
      text: "Approved source text.",
      locale: "en",
      path: "original.md",
      ancestors: [],
      updatedAt: 1,
    },
    approved = approvedSearchKnowledge([document]),
    errors: unknown[] = [],
    dropped: string[] = [];
  let head = "saved-one",
    snapshotReads = 0,
    textProviders = 0,
    textBuilds = 0,
    vectorBuilds = 0;
  const indexer = new SearchIndexer(
    jobs,
    {
      authorize: async () => {},
      head: async () => head,
      current: async () => [document],
      snapshot: async () => {
        snapshotReads++;
        if (!fulltext) throw Error("Unrelated full-text original is unavailable");
        return { commit: head, documents: [document] };
      },
    },
    {
      source: (id) => sources.get(id),
      generation: generationName,
      analyzer: async () => builtinAnalyzer(),
      text: () => {
        textProviders++;
        if (!fulltext) throw Error("Disabled full-text provider must not be required");
        return {
          id: "local",
          fingerprint: () => "text",
          health: async () => true,
          query: async () => [],
          audit: async () => ({ count: 1, checks: [] }),
          build: async (name) => {
            textBuilds++;
            return { name, provider: "local" };
          },
          drop: async () => {},
        };
      },
      vectors: () => ({
        fingerprint: () => "vectors",
        health: async () => true,
        query: async () => [],
        build: async (name) => {
          vectorBuilds++;
          if (sourceChanges && vectorBuilds === 1) head = "saved-two";
          return { name, provider: "milvus" };
        },
        drop: async (reference) => {
          dropped.push(reference.name);
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
  return {
    db,
    jobs,
    scope,
    indexer,
    errors,
    dropped,
    counts: () => ({ snapshotReads, textProviders, textBuilds, vectorBuilds }),
  };
}

async function finished(f: ReturnType<typeof fixture>) {
  const end = Date.now() + 1500;
  while (!["ready", "failed"].includes(f.jobs.get(f.scope)!.state)) {
    if (Date.now() > end) throw Error("Owned build did not finish");
    await Bun.sleep(5);
  }
  return f.jobs.get(f.scope)!;
}

test("a knowledge-only vector generation succeeds without loading unrelated originals or requiring the disabled text provider", async () => {
  const f = fixture(false);
  try {
    f.jobs.configure(
      f.scope,
      {
        ...DEFAULT_SEARCH_SETTINGS,
        enabled: true,
        fulltext: false,
        vector: true,
        knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, mode: "project" },
      },
      0,
    );
    f.indexer.start();
    const row = await finished(f);
    expect(row.state).toBe("ready");
    expect(row.documentCount).toBe(0);
    expect(f.jobs.active(row)).toMatchObject({
      text: null,
      textFingerprint: null,
      knowledgeCommit: "approved",
      vector: { provider: "milvus" },
    });
    expect(f.counts()).toEqual({ snapshotReads: 0, textProviders: 0, textBuilds: 0, vectorBuilds: 1 });
    expect(f.errors).toEqual([]);
  } finally {
    await f.indexer.close();
    f.db.close();
  }
});

test("vector-only metadata capture retains the final source-version fence and discards an obsolete new generation", async () => {
  const f = fixture(false, true);
  try {
    f.jobs.configure(
      f.scope,
      {
        ...DEFAULT_SEARCH_SETTINGS,
        enabled: true,
        fulltext: false,
        vector: true,
        knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, mode: "project" },
      },
      0,
    );
    f.indexer.start();
    const row = await finished(f);
    expect(row.state).toBe("ready");
    expect(row.commitId).toBe("saved-two");
    expect(f.counts()).toEqual({ snapshotReads: 0, textProviders: 0, textBuilds: 0, vectorBuilds: 2 });
    expect(f.dropped).toHaveLength(1);
    expect(f.dropped).not.toContain(f.jobs.active(row)!.vector!.name);
    expect(f.errors).toMatchObject([{ code: "conflict" }]);
  } finally {
    await f.indexer.close();
    f.db.close();
  }
});

test("combined text and knowledge-vector generation still captures originals and builds both indexes", async () => {
  const f = fixture(true);
  try {
    f.jobs.configure(
      f.scope,
      {
        ...DEFAULT_SEARCH_SETTINGS,
        enabled: true,
        fulltext: true,
        vector: true,
        knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, mode: "project" },
      },
      0,
    );
    f.indexer.start();
    const row = await finished(f);
    expect(row.state).toBe("ready");
    expect(row.documentCount).toBe(1);
    expect(f.jobs.active(row)).toMatchObject({
      text: { provider: "local" },
      textFingerprint: "text",
      vector: { provider: "milvus" },
    });
    expect(f.counts()).toEqual({ snapshotReads: 1, textProviders: 1, textBuilds: 1, vectorBuilds: 1 });
    expect(f.errors).toEqual([]);
  } finally {
    await f.indexer.close();
    f.db.close();
  }
});
