import { ContentSearch } from "../../src/server/search/service.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtinAnalyzer, createAnalyzer } from "../../src/server/search/analyzers/registry.js";
import { LocalTextIndex, generationName } from "../../src/server/search/providers/local.js";
import { knowledgeReason } from "../../src/server/search/snippets.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS, analyzerPackage } from "../../src/shared/search/validation.js";
import type { SearchDocument } from "../../src/shared/search/contracts.js";
import { SearchIndexer, type SearchRuntime } from "../../src/server/search/indexer.js";
import type { SearchSource } from "../../src/server/search/ports.js";
import type { SearchVectorDocument } from "../../src/server/search/ports.js";
import { approvedSearchKnowledge } from "../support/search-knowledge-fixture.js";
test("English stemming, stop words and code identifiers share one bounded recipe; language packs cannot execute code", () => {
  const a = builtinAnalyzer();
  expect(a.tokens("The running runners indexed documents")).toEqual(a.tokens("running runners indexed documents"));
  expect(a.tokens("running")).toEqual(a.tokens("runs"));
  expect(a.tokens("getSearchResults")).toContain("search");
  expect(a.tokens("my_package.id")).toContain("=my_package.id");
  const zh = createAnalyzer({
    ...a.descriptor,
    id: "test.zh",
    locale: "zh-CN",
    languages: ["zh"],
    tokenizer: "segmenter",
    stemming: "none",
    stopWords: [],
  });
  expect(zh.tokens("项目文档全文检索").length).toBeGreaterThan(1);
  expect(() => analyzerPackage({ ...a.descriptor, script: "process.exit()" })).toThrow();
  expect(() => analyzerPackage({ ...a.descriptor, locale: "zh", stemming: "porter2" })).toThrow();
});
test("knowledge is opt-in, manual selection does not inherit, tree rules follow ancestry, and exclusions win", () => {
  const base = structuredClone(DEFAULT_SEARCH_SETTINGS.knowledge),
    parent = { id: "parent", ancestors: [] },
    child = { id: "child", ancestors: ["parent"] };
  expect(knowledgeReason(parent, base)).toBe("none");
  base.documents = ["parent"];
  expect(knowledgeReason(parent, base)).toBe("manual");
  expect(knowledgeReason(child, base)).toBe("none");
  base.mode = "selected";
  base.subtrees = ["parent"];
  expect(knowledgeReason(child, base)).toBe("subtree");
  base.exclude = ["parent"];
  expect(knowledgeReason(child, base)).toBe("excluded");
  base.mode = "project";
  expect(knowledgeReason({ id: "other", ancestors: [] }, base)).toBe("project");
});
test("repeated indexing notifications preserve running work while an explicit retry fences its lease", () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    scope = { source: "builtin", owner: "owner", project: "project" };
  try {
    const queued = jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    jobs.wake(queued.key);
    expect(jobs.get(scope)!.requested).toBe(queued.requested);
    const running = jobs.claim()!;
    for (let i = 0; i < 5; i++) jobs.signal(scope.project, scope.owner);
    expect(jobs.get(scope)!.token).toBe(running.token);
    expect(jobs.heartbeat(running)).toBe(true);
    jobs.wake(running.key, true);
    expect(jobs.get(scope)!.state).toBe("queued");
    expect(jobs.get(scope)!.requested).toBe(running.requested + 1);
    expect(jobs.heartbeat(running)).toBe(false);
  } finally {
    db.close();
  }
});
test("source activation uses two revision fences and interrupted builds cannot replace newer rules", () => {
  let now = 1000;
  const db = openSearchDatabase(":memory:"),
    registry = new SearchSourceRegistry(db),
    jobs = new SearchJobs(db, () => now),
    s = { source: "builtin", owner: "owner", project: "project" };
  try {
    jobs.configure(s, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    const first = jobs.claim()!;
    jobs.configure(s, { ...DEFAULT_SEARCH_SETTINGS, enabled: true, vector: false }, 1);
    const active = {
      text: null,
      vector: null,
      analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
      source: registry.get("builtin"),
      sourceRevision: 1,
      settingsRevision: 1,
      embedding: null,
      textFingerprint: null,
    };
    expect(jobs.complete(first, active, "old", 1)).toBe(false);
    const next = jobs.claim()!;
    now += 130000;
    const recovered = jobs.claim()!;
    expect(recovered.token).not.toBe(next.token);
    expect(jobs.complete(next, active, "old", 1)).toBe(false);
    expect(jobs.complete(recovered, active, "new", 2)).toBe(true);
    registry.save(
      { id: "second", name: "Second", kind: "local", connection: null, knowledge: null, enabled: true },
      0,
      () => {},
    );
    expect(() => registry.activate("second", 1, 2)).toThrow("conflict");
    expect(registry.binding().source).toBe("builtin");
    registry.activate("second", 1, 1);
    expect(registry.binding().source).toBe("second");
    expect(() => registry.activate("builtin", 1, 1)).toThrow("conflict");
  } finally {
    db.close();
  }
});
test("explicit generation invalidation fences a running lease without changing the user's index settings revision", () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    scope = { source: "builtin", owner: "owner", project: "project" };
  try {
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
    const first = jobs.claim()!,
      active = {
        text: { name: "a".repeat(64), provider: "local" },
        vector: null,
        analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
        source: sources.get("builtin"),
        sourceRevision: 1,
        settingsRevision: 1,
        embedding: null,
        textFingerprint: "local-test",
      };
    expect(jobs.complete(first, active, "saved1", 1)).toBeTrue();
    jobs.wake(first.key);
    const old = jobs.claim()!;
    jobs.invalidate(first.key);
    expect(jobs.get(scope)!.revision).toBe(1);
    expect(jobs.view(jobs.get(scope)).ready).toBeFalse();
    expect(jobs.active(jobs.get(scope)!)!.invalidated).toBeTrue();
    expect(jobs.heartbeat(old)).toBeFalse();
    expect(jobs.complete(old, active, "saved1", 1)).toBeFalse();
    const fresh = jobs.claim()!;
    expect(
      jobs.complete(fresh, { ...active, text: { name: "b".repeat(64), provider: "local" } }, "saved1", 1),
    ).toBeTrue();
    expect(jobs.view(jobs.get(scope)).ready).toBeTrue();
    const latest = jobs.get(scope)!;
    expect(jobs.invalidate(first.key, old)).toBeFalse();
    expect(jobs.get(scope)).toEqual(latest);
  } finally {
    db.close();
  }
});
test("vector indexing requires approved knowledge and never substitutes selected raw document text", async () => {
  for (const approved of [false, true]) {
    const db = openSearchDatabase(":memory:"),
      jobs = new SearchJobs(db),
      sources = new SearchSourceRegistry(db),
      scope = { source: "builtin", owner: "owner", project: "project" };
    const raw: SearchDocument = {
        id: "doc",
        title: "Title",
        text: "Raw source",
        version: "v1",
        locale: "en",
        path: "doc.md",
        updatedAt: 1,
        ancestors: [],
      },
      sent: SearchVectorDocument[] = [],
      reviewed = approvedSearchKnowledge([raw]);
    const content: SearchSource = {
      authorize: async () => {},
      head: async () => "saved1",
      snapshot: async () => ({ commit: "saved1", documents: [raw] }),
      current: async () => [raw],
    };
    const runtime: SearchRuntime = {
      source: (id) => sources.get(id),
      text: () => ({
        id: "local",
        audit: async () => ({ count: 0, checks: [] }),
        build: async (name) => ({ name, provider: "local" }),
        query: async () => [],
        drop: async () => {},
        health: async () => true,
        fingerprint: () => "text",
      }),
      vectors: () => ({
        build: async (name, documents) => {
          sent.push(...documents);
          return { name, provider: "milvus" };
        },
        query: async () => [],
        drop: async () => {},
        health: async () => true,
        fingerprint: () => "vectors",
      }),
      analyzer: async () => builtinAnalyzer(),
      generation: generationName,
    };
    jobs.configure(
      scope,
      {
        ...DEFAULT_SEARCH_SETTINGS,
        enabled: true,
        vector: true,
        knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, documents: ["doc"] },
      },
      0,
    );
    const indexer = new SearchIndexer(
      jobs,
      content,
      runtime,
      () => {},
      approved
        ? {
            head: async () => "approved1",
            current: async () => [reviewed],
            snapshot: async () => ({
              commit: "approved1",
              records: [reviewed],
            }),
          }
        : undefined,
    );
    try {
      indexer.start();
      for (let i = 0; i < 100 && !["ready", "failed"].includes(jobs.get(scope)!.state); i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(jobs.get(scope)!.state).toBe(approved ? "ready" : "failed");
      expect(sent).toHaveLength(approved ? 1 : 0);
      if (approved) {
        expect(sent[0]!.id).toBe(reviewed.record.id);
        expect(sent[0]!.id).not.toBe(raw.id);
        expect(sent[0]!.version).toBe(reviewed.record.version);
        expect(sent[0]!.text).toContain("Reviewed knowledge with citations");
        expect(sent[0]!.text).not.toBe(raw.text);
      }
    } finally {
      await indexer.close();
      db.close();
    }
  }
});
test("a slow external build leaves an independent slot for built-in indexing", async () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db);
  sources.save(
    { id: "external", name: "External", kind: "elasticsearch", connection: "profile", knowledge: null, enabled: true },
    0,
    () => {},
  );
  let release: () => void = () => {};
  const waiting = new Promise<void>((r) => {
      release = r;
    }),
    local = { source: "builtin", owner: "owner", project: "local" },
    external = { source: "external", owner: "owner", project: "remote" };
  jobs.configure(external, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
  jobs.configure(local, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
  const content: SearchSource = {
    authorize: async () => {},
    head: async () => "v1",
    snapshot: async () => ({ commit: "v1", documents: [] }),
    current: async () => [],
  };
  const runtime: SearchRuntime = {
    source: (id) => sources.get(id),
    text: (source) => ({
      id: source.kind,
      audit: async () => ({ count: 0, checks: [] }),
      health: async () => true,
      fingerprint: () => source.kind,
      drop: async () => {},
      query: async () => [],
      build: async (name) => {
        if (source.kind === "elasticsearch") await waiting;
        return { name, provider: source.kind };
      },
    }),
    vectors: () => null,
    analyzer: async () => builtinAnalyzer(),
    generation: generationName,
  };
  const indexer = new SearchIndexer(jobs, content, runtime, () => {});
  try {
    indexer.start();
    for (let i = 0; i < 100 && jobs.get(local)!.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(jobs.get(local)!.state).toBe("ready");
    expect(jobs.get(external)!.state).toBe("running");
  } finally {
    release();
    await indexer.close();
    db.close();
  }
});
test("the real index worker ranks English titles, survives restart, and drops a generation without blocking the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-search-worker-")),
    entry = resolve("src/server/search/worker-entry.ts"),
    name = generationName("scope", "v1"),
    a = builtinAnalyzer(),
    signal = new AbortController().signal;
  let worker = new LocalTextIndex(root, entry);
  const document = (id: string, title: string, text: string): SearchDocument => ({
    id,
    title,
    text,
    version: "v1",
    locale: "en",
    path: id + ".md",
    updatedAt: 1,
    ancestors: [],
  });
  try {
    expect(await worker.health()).toBe(true);
    const ref = await worker.build(
      name,
      [
        document("a", "Document indexing", "Running index workers"),
        document("b", "Worker notes", "The document index is durable"),
        document("c", "Unrelated", "Nothing here"),
      ],
      a,
      signal,
    );
    expect((await worker.query(ref, "indexing document", a, 20, signal))[0]!.id).toBe("a");
    expect((await worker.query(ref, "running", a, 20, signal)).map((h) => h.id)).toEqual(["a"]);
    await worker.close();
    worker = new LocalTextIndex(root, entry);
    expect((await worker.query(ref, "runs", a, 20, signal)).map((h) => h.id)).toEqual(["a"]);
    expect(await readFile(join(root, name + ".json"), "utf8")).not.toContain("Running index workers");
    await worker.drop(ref);
    await expect(worker.query(ref, "index", a, 20, signal)).rejects.toThrow();
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("user searches cannot reset an exhausted build budget; explicit rebuild still retries", async () => {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    scope = { source: "builtin", owner: "owner", project: "project" };
  let kicks = 0;
  try {
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true, vector: true }, 0);
    jobs.complete(
      jobs.claim()!,
      {
        text: { name: "a".repeat(64), provider: "local" },
        vector: { name: "b".repeat(64), provider: "milvus" },
        analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
        source: sources.get("builtin"),
        sourceRevision: 1,
        settingsRevision: 1,
        embedding: "vectors",
        textFingerprint: "text",
        knowledgeCommit: "approved",
      },
      "old",
      0,
    );
    jobs.wake(jobs.get(scope)!.key);
    for (let n = 0; n < 3; n++) jobs.fail(jobs.claim()!, "unavailable");
    const runtime: SearchRuntime = {
      source: (id) => sources.get(id),
      generation: generationName,
      analyzer: async () => builtinAnalyzer(),
      text: () => ({
        id: "local",
        fingerprint: () => "text",
        health: async () => true,
        audit: async () => ({ count: 0, checks: [] }),
        query: async () => [],
        build: async (name) => ({ name, provider: "local" }),
        drop: async () => {},
      }),
      vectors: () => null,
    };
    const search = new ContentSearch(
      jobs,
      {
        authorize: async () => {},
        head: async () => "new",
        snapshot: async () => ({ commit: "new", documents: [] }),
        current: async () => [],
      },
      runtime,
      () => {
        kicks++;
      },
    );
    for (let n = 0; n < 5; n++) expect((await search.query(scope, "query")).state).toBe("failed");
    expect(jobs.get(scope)!.attempts).toBe(3);
    expect(kicks).toBe(0);
    expect(jobs.invalidate(jobs.get(scope)!.key)).toBeTrue();
    expect((await search.query(scope, "query")).state).toBe("queued");
    expect(jobs.get(scope)!.attempts).toBe(0);
  } finally {
    db.close();
  }
});
