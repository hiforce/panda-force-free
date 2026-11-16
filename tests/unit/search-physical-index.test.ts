import { expect, test } from "bun:test";
import { mkdtemp, rm, unlink, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndexEngine } from "../../src/server/search/providers/local-engine.js";
import { ContentSearch } from "../../src/server/search/service.js";
import { IndexIntegrityError } from "../../src/server/search/integrity.js";
import { SearchError } from "../../src/shared/search/contracts.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import type { SearchCandidate } from "../../src/server/search/ports.js";

test("a hot local cache cannot hide a missing physical generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-physical-search-")),
    provider = new LocalIndexEngine(root),
    analyzer = builtinAnalyzer(),
    signal = new AbortController().signal;
  try {
    const ref = await provider.build(
      "b".repeat(64),
      [
        {
          id: "doc",
          title: "Durable original",
          text: "Index cache recovery",
          version: "rev-1",
          locale: "en",
          path: "doc.md",
          ancestors: [],
          updatedAt: 1,
        },
      ],
      analyzer,
      signal,
    );
    expect(await provider.query(ref, "durable", analyzer, 10, signal)).toHaveLength(1);
    await unlink(join(root, ref.name + ".json"));
    await expect(provider.query(ref, "durable", analyzer, 10, signal)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sealed local generations reject valid JSON with modified saved versions on hot and cold loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-sealed-search-")),
    provider = new LocalIndexEngine(root),
    analyzer = builtinAnalyzer(),
    signal = new AbortController().signal;
  try {
    const ref = await provider.build(
        "c".repeat(64),
        [
          {
            id: "doc",
            title: "Exact original",
            text: "Integrity manifest",
            version: "rev-1",
            locale: "en",
            path: "doc.md",
            ancestors: [],
            updatedAt: 1,
          },
        ],
        analyzer,
        signal,
      ),
      path = join(root, ref.name + ".json"),
      original = await readFile(path, "utf8");
    const modified = original.replaceAll("rev-1", "rev-2");
    expect(modified).not.toBe(original);
    expect(() => JSON.parse(modified)).not.toThrow();
    await writeFile(path, modified);
    await utimes(path, new Date(1000), new Date(1000));
    for (const instance of [provider, new LocalIndexEngine(root)])
      await expect(instance.query(ref, "exact", analyzer, 10, signal)).rejects.toMatchObject({ reason: "corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function failingSearch(query: () => Promise<SearchCandidate[]>) {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    scope = { owner: "owner", project: "project", source: "builtin" };
  jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true }, 0);
  const active = {
    text: { name: "a".repeat(64), provider: "local" },
    vector: null,
    analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
    source: sources.get("builtin"),
    sourceRevision: 1,
    settingsRevision: 1,
    embedding: null,
    textFingerprint: "test",
  };
  jobs.complete(jobs.claim()!, active, "saved", 1);
  let kicks = 0;
  const service = new ContentSearch(
    jobs,
    {
      authorize: async () => {},
      head: async () => "saved",
      snapshot: async () => ({ commit: "saved", documents: [] }),
      current: async () => [],
    },
    {
      source: () => sources.get("builtin"),
      analyzer: async () => builtinAnalyzer(),
      vectors: () => null,
      generation: () => "unused",
      text: () => ({
        id: "local",
        audit: async () => ({ count: 0, checks: [] }),
        build: async () => active.text,
        query,
        drop: async () => {},
        health: async () => true,
        fingerprint: () => "test",
      }),
    },
    () => {
      kicks++;
    },
  );
  return { db, jobs, scope, active, service, kicks: () => kicks };
}

test("a first page refreshes once when a replacement generation activates during a successful read", async () => {
  let reads = 0;
  const f = failingSearch(async () => {
    if (++reads === 1) {
      f.jobs.wake(f.jobs.get(f.scope)!.key, true);
      f.jobs.complete(f.jobs.claim()!, { ...f.active, text: { name: "b".repeat(64), provider: "local" } }, "saved", 1);
    }
    return [];
  });
  try {
    expect(await f.service.query(f.scope, "query")).toMatchObject({ hits: [], state: "ready" });
    expect(reads).toBe(2);
    expect(f.jobs.active(f.jobs.get(f.scope)!)?.invalidated).toBeUndefined();
  } finally {
    f.db.close();
  }
});

test("repeated activation cannot turn first-page refresh into an unbounded read loop", async () => {
  let reads = 0;
  const f = failingSearch(async () => {
    reads++;
    f.jobs.wake(f.jobs.get(f.scope)!.key, true);
    f.jobs.complete(
      f.jobs.claim()!,
      { ...f.active, text: { name: (reads === 1 ? "b" : "c").repeat(64), provider: "local" } },
      "saved",
      1,
    );
    return [];
  });
  try {
    await expect(f.service.query(f.scope, "query")).rejects.toMatchObject({ code: "indexChanged" });
    expect(reads).toBe(2);
    expect(f.jobs.active(f.jobs.get(f.scope)!)?.invalidated).toBeUndefined();
  } finally {
    f.db.close();
  }
});

test("provider outages and authorization failures leave the physical generation unchanged", async () => {
  for (const code of ["unavailable", "forbidden"] as const) {
    const f = failingSearch(async () => {
      throw new SearchError(code, 503);
    });
    try {
      const before = f.jobs.get(f.scope);
      await expect(f.service.query(f.scope, "query")).rejects.toMatchObject({ code });
      expect(f.jobs.get(f.scope)).toEqual(before);
      expect(f.kicks()).toBe(0);
    } finally {
      f.db.close();
    }
  }
});

test("a late failed physical read cannot invalidate a newer generation", async () => {
  const f = failingSearch(async () => {
    f.jobs.wake(f.jobs.get(f.scope)!.key, true);
    f.jobs.complete(f.jobs.claim()!, { ...f.active, text: { name: "b".repeat(64), provider: "local" } }, "saved", 1);
    throw new IndexIntegrityError("missing");
  });
  try {
    await expect(f.service.query(f.scope, "query")).rejects.toMatchObject({ code: "indexChanged" });
    const row = f.jobs.get(f.scope)!;
    expect(row.state).toBe("ready");
    expect(f.jobs.active(row)?.text?.name).toBe("b".repeat(64));
    expect(f.jobs.active(row)?.invalidated).toBeUndefined();
    expect(f.kicks()).toBe(0);
  } finally {
    f.db.close();
  }
});

test("a non-regular cold snapshot is rejected without waiting for a filesystem reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-search-special-file-")),
    provider = new LocalIndexEngine(root),
    analyzer = builtinAnalyzer(),
    signal = new AbortController().signal;
  try {
    const name = "d".repeat(64),
      path = join(root, name + ".json");
    const created = Bun.spawnSync(["mkfifo", path]);
    expect(created.exitCode).toBe(0);
    await expect(provider.query({ name, provider: "local" }, "query", analyzer, 10, signal)).rejects.toMatchObject({
      reason: "corrupt",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
