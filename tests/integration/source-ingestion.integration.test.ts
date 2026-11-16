import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sourceStageFixture, deferred } from "../support/source-staging.js";
import { sourceIngestionFixture } from "../support/source-provider.js";
import { uploadBody } from "../support/source-upload.js";
import { sourceCaptureBytes } from "../../src/server/packages/ingestion/runtime.js";
import { SourceError } from "../../src/shared/packages/sources/contracts.js";
import type { SourceCaptureProvider } from "../../src/server/packages/ingestion/providers.js";

const githubRequest = (connectionId?: string) => ({
  source: {
    kind: "github",
    repository: "example/themes",
    ref: "main",
    repositoryId: 42,
    ...(connectionId ? { connectionId } : {}),
  },
});

test("the ingestion worker waits for a durable ZIP upload and captures actual source bytes without running scripts", async () => {
  const f = await sourceStageFixture(),
    r = sourceIngestionFixture(f);
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), f.request());
    r.manager.poll();
    await r.manager.settle();
    expect(r.manager.read("owner", "templates", stage.id).state).toBe("reserved");
    expect(r.runtime.snapshot()).toEqual({ bytes: 0, active: 0 });
    expect(
      (await r.manager.upload("owner", "templates", stage.id, stage.revision, uploadBody(f.archive, 23).body)).state,
    ).toBe("uploaded");
    r.manager.poll();
    await r.manager.settle();
    const ready = r.manager.read("owner", "templates", stage.id);
    expect(ready.state).toBe("ready");
    expect((await r.stages.templates.content("owner", stage.id)).tree.text("theme/layout/index.ejs")).toBe(
      "<h1>Private original theme body</h1>",
    );
    expect(await readdir(join(f.contentRoot, stage.id))).toEqual([ready.digest + ".source"]);
    expect(r.github.calls).toHaveLength(0);
    expect(r.diagnostics).toEqual([]);
    expect(r.runtime.snapshot()).toEqual({ bytes: 0, active: 0 });
  } finally {
    await r.close();
    await f.dispose();
  }
});

test("GitHub capture passes trusted owner and purpose to each credential read and keeps secrets outside provenance", async () => {
  const f = await sourceStageFixture(),
    auth: string[][] = [],
    r = sourceIngestionFixture(f, {
      credentials: {
        async token(actor, purpose, id, signal) {
          auth.push([actor, purpose, id]);
          expect(signal.aborted).toBe(false);
          return purpose === "templates" ? "TEST_READ_ONLY_TOKEN" : null;
        },
      },
    });
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), githubRequest("chosen-connection"));
    r.manager.poll();
    await r.manager.settle();
    const ready = r.manager.read("owner", "templates", stage.id),
      source = await r.stages.templates.content("owner", stage.id);
    expect(ready.state).toBe("ready");
    expect(source.descriptor.origin).toMatchObject({
      kind: "github",
      repositoryId: 42,
      commit: r.github.commit,
      requestedRef: "main",
    });
    expect(source.tree.read("layout/index.ejs")).toEqual(r.github.content);
    expect(auth).toHaveLength(r.github.calls.length);
    expect(auth.every((value) => value.join("/") === "owner/templates/chosen-connection")).toBe(true);
    expect(r.github.calls.every((call) => call.headers.Authorization === "Bearer TEST_READ_ONLY_TOKEN")).toBe(true);
    expect(JSON.stringify(source.descriptor)).not.toContain("chosen-connection");
    expect(JSON.stringify(f.db.query("SELECT * FROM package_source_stages").all())).not.toContain(
      "TEST_READ_ONLY_TOKEN",
    );
    const before = r.github.calls.length,
      denied = await r.manager.submit("owner", "skills", randomUUID(), githubRequest("chosen-connection"));
    r.manager.poll();
    await r.manager.settle();
    expect(r.manager.read("owner", "skills", denied.id)).toMatchObject({
      state: "failed",
      failure: "sourceAccessDenied",
    });
    expect(r.github.calls).toHaveLength(before);
  } finally {
    await r.close();
    await f.dispose();
  }
});

test("cancellation does not recycle a capture allocation until its provider has released its real work", async () => {
  const f = await sourceStageFixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  let firstId = "";
  const provider: SourceCaptureProvider = {
      async capture(_actor, _purpose, id) {
        expect(id).toBe(firstId);
        entered.resolve();
        await release.promise;
        throw new SourceError("sourceCancelled");
      },
    },
    r = sourceIngestionFixture(f, { provider, runtime: { bytes: 256 * 1024 * 1024, parallel: 2 } });
  try {
    const first = await r.manager.submit("owner", "templates", randomUUID(), githubRequest());
    firstId = first.id;
    f.advance(1);
    const second = await r.manager.submit("owner", "templates", randomUUID(), githubRequest()),
      cost = sourceCaptureBytes(first);
    expect(cost * 2).toBeGreaterThan(r.runtime.limits.bytes);
    r.manager.poll();
    await entered.promise;
    r.manager.cancel("owner", "templates", first.id, r.manager.read("owner", "templates", first.id).revision);
    r.manager.poll();
    expect(r.manager.read("owner", "templates", first.id).state).toBe("cancelled");
    expect(r.manager.read("owner", "templates", second.id).state).toBe("reserved");
    expect(r.runtime.snapshot()).toEqual({ bytes: cost, active: 1 });
    release.resolve();
    await r.manager.settle();
    expect(r.runtime.snapshot()).toEqual({ bytes: 0, active: 0 });
    expect(await readdir(join(f.contentRoot, first.id))).toEqual([]);
  } finally {
    release.resolve();
    await r.close();
    await f.dispose();
  }
});

test("startup reconciliation restores uploaded originals but never re-resolves an interrupted mutable GitHub ref", async () => {
  const f = await sourceStageFixture(),
    r = sourceIngestionFixture(f);
  try {
    const zip = await r.manager.submit("owner", "templates", randomUUID(), f.request()),
      upload = f.store.claimUpload("owner", zip.id, zip.revision, f.now(), 100);
    if (zip.request.source.kind !== "zip-upload") throw Error("Expected ZIP intent");
    await f.files.upload(zip.id, zip.request.source, uploadBody(f.archive).body, new AbortController().signal);
    const github = await r.manager.submit("owner", "templates", randomUUID(), githubRequest());
    f.store.claim("owner", github.id, github.revision, f.now(), 100);
    f.advance(101);
    r.manager.poll();
    await r.manager.settle();
    expect(r.manager.read("owner", "templates", zip.id).state).toBe("uploaded");
    expect(r.manager.read("owner", "templates", github.id)).toMatchObject({ state: "failed", failure: "interrupted" });
    expect(r.github.calls).toHaveLength(0);
    expect(() => f.store.uploaded("owner", upload, f.now())).toThrow("stageConflict");
    r.manager.poll();
    await r.manager.settle();
    expect(r.manager.read("owner", "templates", zip.id).state).toBe("ready");
  } finally {
    await r.close();
    await f.dispose();
  }
});

test("an oversized runtime request records a durable failure without dispatching a provider", async () => {
  const f = await sourceStageFixture(),
    r = sourceIngestionFixture(f, { runtime: { bytes: 16 * 1024 * 1024, parallel: 1 } });
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), githubRequest());
    r.manager.poll();
    await r.manager.settle();
    expect(r.manager.read("owner", "templates", stage.id)).toMatchObject({
      state: "failed",
      failure: "sourceTooLarge",
    });
    expect(r.github.calls).toHaveLength(0);
    expect(r.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
  } finally {
    await r.close();
    await f.dispose();
  }
});

test("recovery backs off while a live upload still owns its files instead of repeatedly retrying in the same clock tick", async () => {
  const f = await sourceStageFixture(),
    r = sourceIngestionFixture(f),
    entered = deferred<void>(),
    release = deferred<void>();
  let pending: Promise<unknown> | undefined;
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), f.request());
    pending = r.stages.templates.upload("owner", stage.id, stage.revision, {
      chunks: {
        async *[Symbol.asyncIterator]() {
          entered.resolve();
          await release.promise;
          yield f.archive;
        },
      },
      cancel() {
        release.resolve();
      },
    });
    await entered.promise;
    f.advance(20000);
    r.manager.poll();
    await r.manager.settle();
    expect(r.diagnostics).toEqual([{ id: stage.id, code: "stageBusy" }]);
    for (let attempt = 0; attempt < 5; attempt++) {
      r.manager.poll();
      await r.manager.settle();
    }
    expect(r.diagnostics).toHaveLength(1);
    expect(r.manager.read("owner", "templates", stage.id).state).toBe("uploading");
    f.advance(1000);
    r.manager.poll();
    await r.manager.settle();
    expect(r.diagnostics).toHaveLength(2);
    expect(r.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
    r.manager.cancel("owner", "templates", stage.id, r.manager.read("owner", "templates", stage.id).revision);
    await pending;
    expect(r.manager.read("owner", "templates", stage.id).state).toBe("cancelled");
  } finally {
    release.resolve();
    await pending;
    await r.close();
    await f.dispose();
  }
});

test("source inspection holds its allocation until projection completes and rejects a result invalidated by removal", async () => {
  const f = await sourceStageFixture(),
    r = sourceIngestionFixture(f),
    entered = deferred<void>(),
    release = deferred<void>();
  try {
    const task = await r.manager.submit("owner", "templates", randomUUID(), f.request());
    await r.manager.upload("owner", "templates", task.id, task.revision, uploadBody(f.archive).body);
    r.manager.poll();
    await r.manager.settle();
    const projected = r.manager.project("owner", "templates", task.id, async (source) => {
      entered.resolve();
      await release.promise;
      return source.descriptor;
    });
    const observed = projected.then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    expect(r.runtime.snapshot().active).toBe(1);
    const current = r.manager.read("owner", "templates", task.id);
    expect(await r.manager.remove("owner", "templates", task.id, current.revision)).toMatchObject({
      state: "removed",
      reservedBytes: 0,
    });
    expect(r.runtime.snapshot().active).toBe(1);
    release.resolve();
    expect(await observed).toMatchObject({ code: "stageConflict" });
    expect(r.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
  } finally {
    release.resolve();
    await r.close();
    await f.dispose();
  }
});
