import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEmbeddingService } from "../../src/server/search/embeddings/service.js";
import { EmbeddingBudget } from "../../src/server/search/embeddings/budget.js";
import { embeddingPolicy } from "../../src/server/search/embeddings/policy.js";
import type { SearchEmbeddingProvider } from "../../src/server/search/ports.js";
import type { SearchScope } from "../../src/shared/search/contracts.js";

const scope: SearchScope = { owner: "alice-private", project: "project-one", source: "builtin" };
const vector = (text: string) => [text.length / 10, 0.2, 0.3, 0.4];
async function fixture(overrides: Record<string, number> = {}) {
  const root = await mkdtemp(join(tmpdir(), "panda-embedding-cache-")),
    database = join(root, "data", "embeddings.sqlite"),
    files = join(root, "cache"),
    calls: { texts: string[]; purpose?: string }[] = [],
    errors: unknown[] = [];
  let now = 1000000,
    recipe = "model-recipe-one",
    work: SearchEmbeddingProvider["embed"] | null = null;
  const raw: SearchEmbeddingProvider = {
      dimensions: 4,
      fingerprint: () => recipe,
      health: async () => true,
      embed: async (texts, signal, purpose) => {
        calls.push({ texts, purpose });
        return work ? work(texts, signal, purpose) : texts.map(vector);
      },
    },
    policy = embeddingPolicy(overrides);
  let manager = new SearchEmbeddingService(
    database,
    files,
    "instance-one",
    policy,
    (error) => errors.push(error),
    () => now,
  );
  return {
    root,
    database,
    files,
    calls,
    errors,
    provider: (selected = scope, connection = "model") => manager.provider(raw, connection, selected),
    metadata: () => manager.provider(raw, "model"),
    usage: (owner = scope.owner) => manager.usage(owner),
    time: (value: number) => {
      now = value;
    },
    recipe: (value: string) => {
      recipe = value;
    },
    work: (value: typeof work) => {
      work = value;
    },
    close: () => manager.close(),
    async restart() {
      await manager.close();
      manager = new SearchEmbeddingService(
        database,
        files,
        "instance-one",
        policy,
        (error) => errors.push(error),
        () => now,
      );
    },
    async dispose() {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("chunk and query vectors survive restart, deduplicate input and isolate owner/project/model/purpose", async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    text = "private-input-marker-" + crypto.randomUUID();
  try {
    expect(f.usage().calls).toBe(0);
    expect(await readdir(f.root)).toEqual([]);
    const result = await f.provider().embed([text, text, "another chunk"], signal);
    expect(result[0]).toEqual(result[1]);
    expect(f.calls).toEqual([{ texts: [text, "another chunk"], purpose: "document" }]);
    await f.provider().embed([text, "changed chunk"], signal);
    expect(f.calls[1]!.texts).toEqual(["changed chunk"]);
    await f.provider().embed([text], signal, "query");
    expect(f.calls.length).toBe(3);
    await f.restart();
    await f.provider().embed([text, "another chunk", "changed chunk"], signal);
    await f.provider().embed([text], signal, "query");
    await f.provider({ ...scope, source: "diagnostic" }).embed([text], signal);
    expect(f.calls.length).toBe(3);
    await f.provider({ ...scope, owner: "bob" }).embed([text], signal);
    await f.provider({ ...scope, project: "project-two" }).embed([text], signal);
    await f.provider(scope, "new-connection").embed([text], signal);
    f.recipe("changed-model-recipe");
    await f.provider().embed([text], signal);
    expect(f.calls.length).toBe(7);
    expect(f.usage().calls).toBe(6);
    expect(f.usage("bob").calls).toBe(1);
    await f.restart();
    expect(f.usage().calls).toBe(6);
    expect(f.calls.length).toBe(7);
    const db = new Database(f.database, { readonly: true });
    try {
      const rows = db.query("SELECT * FROM embedding_cache").all();
      expect(JSON.stringify(rows)).not.toContain(text);
      expect(JSON.stringify(rows)).not.toContain(scope.owner);
    } finally {
      db.close();
    }
    expect((await readFile(f.database)).includes(Buffer.from(text))).toBe(false);
    for (const file of await readdir(f.files))
      expect((await readFile(join(f.files, file))).includes(Buffer.from(text))).toBe(false);
    await expect(f.metadata().embed([text], signal)).rejects.toMatchObject({ code: "configuration" });
    expect(f.calls.length).toBe(7);
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("corrupt and missing cache files are not served; expiry, eviction and owned write leftovers recover", async () => {
  const f = await fixture({ cacheEntries: 2, queryTtlMinutes: 1 }),
    signal = new AbortController().signal;
  try {
    await f.provider().embed(["first"], signal, "query");
    let files = await readdir(f.files);
    const path = join(f.files, files[0]!),
      bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(path, bytes);
    const repaired = await f.provider().embed(["first"], signal, "query");
    expect(repaired[0]![0]).toBe(Math.fround(0.5));
    expect(f.calls.length).toBe(2);
    files = await readdir(f.files);
    await unlink(join(f.files, files[0]!));
    await f.provider().embed(["first"], signal, "query");
    expect(f.calls.length).toBe(3);
    f.time(1060001);
    await f.provider().embed(["first"], signal, "query");
    expect(f.calls.length).toBe(4);
    await f.provider().embed(["second"], signal, "query");
    await f.provider().embed(["third"], signal, "query");
    expect((await readdir(f.files)).length).toBe(2);
    const db = new Database(f.database);
    try {
      db.query("UPDATE embedding_cache SET state='writing',expiresAt=0").run();
    } finally {
      db.close();
    }
    await f.provider().embed(["fourth"], signal, "query");
    expect((await readdir(f.files)).length).toBe(1);
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("identical concurrent requests share inference; cancelling a waiter does not release another request", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let finish!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.work(async (texts) => {
    entered();
    await pending;
    return texts.map(vector);
  });
  try {
    const first = f.provider().embed(["same query"], new AbortController().signal, "query");
    await started;
    const waiter = f
      .provider()
      .embed(["same query"], controller.signal, "query")
      .catch((error: unknown) => error);
    controller.abort();
    expect((await waiter) instanceof Error).toBe(true);
    expect(f.calls.length).toBe(1);
    const second = f.provider().embed(["same query"], new AbortController().signal, "query");
    finish();
    expect(await second).toEqual(await first);
    expect(f.calls.length).toBe(1);
  } finally {
    finish();
    await f.dispose();
  }
});

test("an aborted provider keeps its reservation until settlement and its cooldown survives restart", async () => {
  const f = await fixture({ concurrent: 1 }),
    controller = new AbortController();
  let finish!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.work(async (_texts, signal) => {
    entered();
    await pending;
    signal.throwIfAborted();
    return [vector("unused")];
  });
  try {
    const first = f
      .provider()
      .embed(["timeout"], controller.signal, "query")
      .catch((error: unknown) => error);
    await started;
    controller.abort();
    await expect(
      f.provider({ ...scope, owner: "bob" }).embed(["other"], new AbortController().signal, "query"),
    ).rejects.toMatchObject({ code: "limit" });
    expect(f.calls.length).toBe(1);
    finish();
    expect((await first) instanceof Error).toBe(true);
    await f.restart();
    f.work(null);
    await expect(f.provider().embed(["retry"], new AbortController().signal, "query")).rejects.toMatchObject({
      code: "limit",
    });
    expect(f.calls.length).toBe(1);
    f.time(1060001);
    await f.provider().embed(["retry"], new AbortController().signal, "query");
    expect(f.calls.length).toBe(2);
  } finally {
    finish();
    await f.dispose();
  }
});

test("a late result cannot publish after its durable lease was replaced", async () => {
  const f = await fixture();
  let finish!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.work(async (texts) => {
    entered();
    await pending;
    return texts.map(vector);
  });
  try {
    const old = f
      .provider()
      .embed(["late result"], new AbortController().signal, "query")
      .catch((error: unknown) => error);
    await started;
    f.time(1060001);
    const db = new Database(f.database),
      replacement = crypto.randomUUID();
    let reservation: string;
    try {
      const lock = db.query<{ namespace: string }, []>("SELECT namespace FROM embedding_locks").get()!,
        model = db.query<{ model: string }, []>("SELECT model FROM embedding_inflight").get()!.model;
      db.query("UPDATE embedding_locks SET token=?,untilAt=? WHERE namespace=?").run(
        replacement,
        1120001,
        lock.namespace,
      );
      reservation = new EmbeddingBudget(db, embeddingPolicy(), () => 1060001).admit(model, scope.owner, 1);
      finish();
      expect(await old).toMatchObject({ code: "conflict" });
      expect(db.query<{ token: string }, []>("SELECT token FROM embedding_locks").get()!.token).toBe(replacement);
      expect(db.query<{ token: string }, []>("SELECT token FROM embedding_inflight").get()!.token).toBe(reservation);
      expect(db.query<{ n: number }, []>("SELECT count(*) n FROM embedding_cache").get()!.n).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    finish();
    await f.dispose();
  }
});
