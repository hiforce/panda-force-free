import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchIndexResources, resourceGraceMs } from "../../src/server/search/storage/resources.js";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { MilvusStorage } from "../../src/server/search/providers/milvus-storage.js";
import { MilvusIndex } from "../../src/server/search/providers/milvus.js";
import { VectorSealStore } from "../../src/server/search/providers/vector-seal.js";
import { vectorResourceOwner } from "../../src/server/search/integration/vector-resources.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { SearchEmbeddingProvider } from "../../src/server/search/ports.js";
import { milvusHttpFixture } from "../support/milvus-http-fixture.js";
import { reconcileIndexResources, type IndexResourceCursor } from "../../src/server/search/resources/inventory.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-index-lifecycle-")),
    peer = milvusHttpFixture(),
    errors: unknown[] = [],
    instance = "isolated-owned-resources";
  let db = openSearchDatabase(join(root, "search.sqlite")),
    now = 1000000,
    calls = 0,
    fail = false,
    gate: Promise<void> | null = null;
  let registry = new SearchIndexResources(db, () => now);
  const http = new SearchHttp({ id: "vectors", kind: "milvus", url: peer.endpoint }, async () => ({
      apiKey: "fixture-vector-key",
    })),
    storage = new MilvusStorage(http, instance),
    seals = new VectorSealStore(join(root, "vectors")),
    embeddings: SearchEmbeddingProvider = {
      dimensions: 4,
      fingerprint: () => "e".repeat(64) + "/chunks-v1",
      health: async () => true,
      async embed(texts, _signal, purpose) {
        calls++;
        if (fail) throw Error("Embedding fixture unavailable");
        if (purpose === "query") await gate;
        return texts.map(() => [1, 0, 0, 0]);
      },
    },
    owner = () => vectorResourceOwner(http, instance, registry, seals, (error) => errors.push(error)),
    provider = (managed = true) => new MilvusIndex(http, embeddings, instance, seals, managed ? owner() : undefined),
    documents = [
      {
        id: "approved-record",
        title: "Durable knowledge",
        text: "A reviewed source-bound result.",
        version: "a".repeat(64),
      },
    ];
  return {
    root,
    peer,
    storage,
    provider,
    owner,
    documents,
    errors,
    registry: () => registry,
    db: () => db,
    calls: () => calls,
    fail: (value: boolean) => {
      fail = value;
    },
    gate: (value: Promise<void> | null) => {
      gate = value;
    },
    tick: (value: number) => {
      now += value;
    },
    reopen() {
      db.close();
      db = openSearchDatabase(join(root, "search.sqlite"));
      registry = new SearchIndexResources(db, () => now);
    },
    async close() {
      db.close();
      await peer.server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("managed Milvus path persists exact physical ownership and protects active generations across restart", async () => {
  const f = await fixture(),
    name = "a".repeat(64),
    signal = AbortSignal.timeout(10000);
  try {
    const provider = f.provider(),
      ref = await provider.build(name, f.documents, signal),
      storage = f.owner().storage.id;
    expect(f.registry().get(storage, name)?.identity).toBe("448707763883002001");
    expect(f.registry().get(storage, name)?.state).toBe("ready");
    expect(f.peer.collections.get(f.storage.collection(name))?.marker).toContain(
      "panda-index/1/" + storage + "/" + name,
    );
    const jobs = new SearchJobs(f.db()),
      scope = { owner: "owner", source: "builtin", project: "personal" };
    jobs.configure(scope, { ...DEFAULT_SEARCH_SETTINGS, enabled: true, fulltext: false, vector: true }, 0);
    const row = jobs.claim()!;
    expect(
      jobs.complete(
        row,
        {
          text: null,
          vector: ref,
          analyzer: DEFAULT_SEARCH_SETTINGS.analyzer,
          source: new SearchSourceRegistry(f.db()).get("builtin"),
          sourceRevision: 1,
          settingsRevision: row.revision,
          embedding: provider.fingerprint(),
          textFingerprint: null,
        },
        "approved-commit",
        1,
      ),
    ).toBeTrue();
    const before = f.calls();
    await expect(provider.drop(ref)).rejects.toMatchObject({ reason: "unverified" });
    expect(f.calls()).toBe(before);
    expect(f.peer.collections.has(f.storage.collection(name))).toBeTrue();
    f.reopen();
    expect((await f.provider().query(ref, "durable", 10, signal))[0]?.id).toBe("approved-record");
    expect((await f.provider().audit(ref, signal)).count).toBe(1);
    expect(
      (await readFile(join(f.root, "vectors", name + ".json"), "utf8")).includes("reviewed source-bound"),
    ).toBeFalse();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);

test("an unknown create acknowledgement and failed compensation retain recoverable owned allocation", async () => {
  const f = await fixture(),
    name = "b".repeat(64),
    signal = AbortSignal.timeout(10000);
  try {
    f.peer.faults.createUnknown = 1;
    f.peer.faults.drop = 1;
    await expect(f.provider().build(name, f.documents, signal)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.calls()).toBe(0);
    const storage = f.owner().storage.id;
    expect(f.registry().get(storage, name)?.state).toBe("retiring");
    expect(f.peer.collections.has(f.storage.collection(name))).toBeTrue();
    expect(f.errors).toHaveLength(1);
    f.reopen();
    f.tick(120001);
    expect(await f.owner().drop(name, false, signal)).toBeFalse();
    f.tick(resourceGraceMs + 1);
    expect(await f.owner().drop(name, false, signal)).toBeTrue();
    expect(f.registry().get(storage, name)?.state).toBe("deleted");
    expect(f.peer.collections.has(f.storage.collection(name))).toBeFalse();
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
}, 20000);

test("inflight semantic reads block physical deletion and replaced collection identity stops inference", async () => {
  const f = await fixture(),
    name = "c".repeat(64),
    signal = AbortSignal.timeout(10000);
  try {
    const ref = await f.provider().build(name, f.documents, signal),
      before = f.calls();
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const reading = f.provider().query(ref, "durable", 10, signal);
    while (f.calls() === before) await Bun.sleep(2);
    expect(await f.owner().drop(name, true, signal)).toBeFalse();
    release();
    await reading;
    f.gate(null);
    f.peer.collections.get(f.storage.collection(name))!.identity = "448707763883002099";
    const after = f.calls();
    await expect(f.provider().query(ref, "durable", 10, signal)).rejects.toMatchObject({ reason: "corrupt" });
    expect(f.calls()).toBe(after);
    expect(await f.owner().drop(name, true, signal)).toBeFalse();
    expect(f.registry().get(f.owner().storage.id, name)?.state).toBe("unverified");
  } finally {
    await f.close();
  }
}, 20000);

test("unowned legacy collections remain readable and never acquire cleanup authority from their prefix", async () => {
  const f = await fixture(),
    name = "d".repeat(64),
    signal = AbortSignal.timeout(10000);
  try {
    const ref = await f.provider(false).build(name, f.documents, signal);
    expect(f.registry().get(f.owner().storage.id, name)).toBeNull();
    expect((await f.provider().query(ref, "durable", 10, signal))[0]?.id).toBe("approved-record");
    await expect(f.provider().drop(ref)).rejects.toMatchObject({ reason: "unverified" });
    expect(f.peer.collections.has(f.storage.collection(name))).toBeTrue();
    expect(f.registry().get(f.owner().storage.id, name)).toBeNull();
  } finally {
    await f.close();
  }
}, 20000);

test("physical inventory retires proven orphan allocations after grace while retaining unowned collections without inference", async () => {
  const f = await fixture(),
    signal = AbortSignal.timeout(10000),
    owned = "e".repeat(64),
    legacy = "f".repeat(64);
  try {
    await f.provider().build(owned, f.documents, signal);
    await f.provider(false).build(legacy, f.documents, signal);
    const calls = f.calls(),
      errors: unknown[] = [];
    const first = await reconcileIndexResources(f.owner(), { physical: "", allocations: "" }, signal, (e) =>
      errors.push(e),
    );
    expect(first.report.removed).toBe(0);
    expect(first.report.unowned).toBe(1);
    f.reopen();
    f.tick(resourceGraceMs + 1);
    const second = await reconcileIndexResources(f.owner(), { physical: "", allocations: "" }, signal, (e) =>
      errors.push(e),
    );
    expect(second.report.removed).toBe(1);
    expect(second.report.unowned).toBe(1);
    expect(f.peer.collections.has(f.storage.collection(owned))).toBeFalse();
    expect(f.peer.collections.has(f.storage.collection(legacy))).toBeTrue();
    expect(f.calls()).toBe(calls);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);

test("bounded metadata inventory advances past interrupted allocations that never reached the remote service", async () => {
  const f = await fixture(),
    names = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(64, "0")),
    storage = f.owner().storage.id,
    errors: unknown[] = [];
  async function pass() {
    let cursor: IndexResourceCursor = { physical: "", allocations: "" },
      checked = 0,
      removed = 0;
    do {
      const batch = await reconcileIndexResources(f.owner(), cursor, AbortSignal.timeout(10000), (e) => errors.push(e));
      expect(batch.report.checked).toBeLessThanOrEqual(16);
      checked += batch.report.checked;
      removed += batch.report.removed;
      cursor = batch.next;
    } while (cursor.physical !== null || cursor.allocations !== null);
    return { checked, removed };
  }
  try {
    f.db()
      .transaction(() => {
        for (const name of names) {
          const allocated = f.registry().reserve(storage, name, "isolated-recipe", "allocation/" + name);
          f.registry().release({ storage, name, token: allocated.token! });
        }
      })
      .immediate();
    f.reopen();
    expect(await pass()).toEqual({ checked: 40, removed: 0 });
    f.tick(resourceGraceMs + 1);
    expect(await pass()).toEqual({ checked: 40, removed: 40 });
    expect(f.registry().page(storage)).toEqual([]);
    expect(names.every((name) => f.registry().get(storage, name)?.state === "deleted")).toBeTrue();
    expect(f.calls()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);
