import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, truncate, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resourceBuildFixture, resourceBuildArtifact } from "../support/resource-build.js";
import { ResourceBuildRequest } from "../../src/shared/builds/resources.js";
import {
  RESOURCE_FRAME_CONTENT_TYPE,
  RESOURCE_FRAME_MAX,
  encodeResourceBuild,
} from "../../src/shared/builds/resource-frame.js";
import { BUILD_LIMITS } from "../../src/shared/builds/validation.js";
import { ExecutionStore } from "../../src/executor/store.js";
import { ExecutionService } from "../../src/executor/service.js";
import { executionHandler } from "../../src/executor/http.js";
import { HttpSiteExecutor } from "../../src/server/builds/adapters/http-executor.js";

test("real application-to-executor HTTP preserves binary resources and stable job identities across retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-build-http-")),
    token = "a".repeat(64),
    id = randomUUID(),
    f = await resourceBuildFixture();
  let runs = 0;
  const store = new ExecutionStore(join(root, "state")),
    service = new ExecutionService(
      store,
      {
        async run(current, input, _signal, update) {
          runs++;
          expect(current).toBe(id);
          expect(input instanceof ResourceBuildRequest).toBe(true);
          if (!(input instanceof ResourceBuildRequest)) throw Error("Wrong execution format");
          expect(input.digest).toBe(f.request.digest);
          expect(input.tree.read("source/logo.bin")).toEqual(new Uint8Array([0, 10, 255]));
          update({ phase: "running" });
          return resourceBuildArtifact();
        },
        async cleanup() {},
      },
      () => {},
    ),
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: executionHandler(service, token) });
  try {
    await writeFile(join(root, "token"), token);
    const remote = new HttpSiteExecutor(server.url.origin, join(root, "token"));
    expect((await remote.availability()).nativeResources).toBe(true);
    expect((await remote.startResource(id, f.request)).inputHash).toBe(f.request.digest);
    expect((await remote.startResource(id, f.request)).inputHash).toBe(f.request.digest);
    for (let i = 0; i < 100 && (await remote.status(id)).phase !== "completed"; i++) await Bun.sleep(5);
    expect((await remote.status(id)).phase).toBe("completed");
    expect(await remote.result(id)).toEqual(resourceBuildArtifact());
    expect(runs).toBe(1);
    expect((await readdir(join(root, "state/jobs", id))).sort()).toEqual(["result.json", "state.json"]);
    expect((await remote.startResource(id, f.request)).phase).toBe("completed");
    expect(runs).toBe(1);
    const changed = await resourceBuildFixture({ other: "Different resources" });
    await expect(remote.startResource(id, changed.request)).rejects.toThrow("executorConflict");
  } finally {
    service.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("durable native inputs survive new store instances and restart cleanup never automatically reruns them", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-build-recovery-")),
    f = await resourceBuildFixture(),
    id = randomUUID();
  try {
    let store = new ExecutionStore(root);
    store.createResource(id, f.request);
    const bytes = await readFile(join(root, "jobs", id, "input.build"));
    expect(bytes.includes(Buffer.from("PFBLD02"))).toBe(true);
    store = new ExecutionStore(root);
    const restored = await store.request(id);
    expect(restored instanceof ResourceBuildRequest).toBe(true);
    if (restored instanceof ResourceBuildRequest) expect(restored.digest).toBe(f.request.digest);
    let cleanups = 0;
    const service = new ExecutionService(
      store,
      {
        async run() {
          throw Error("Unexpected replay");
        },
        async cleanup(current) {
          expect(current).toBe(id);
          cleanups++;
        },
      },
      () => {},
    );
    await service.recover();
    expect(cleanups).toBe(1);
    expect(await service.status(id)).toMatchObject({
      phase: "failed",
      error: "executorRestarted",
      inputHash: f.request.digest,
    });
    expect((await readdir(join(root, "jobs", id))).sort()).toEqual(["state.json"]);
    service.close();
    const orphan = randomUUID();
    await mkdir(join(root, "jobs", orphan));
    await writeFile(join(root, "jobs", orphan, "input.build"), bytes);
    store.prune();
    expect(await readdir(join(root, "jobs"))).toEqual([id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native admission capacity remains held until cancellation of the real request stream drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-build-cancel-")),
    token = "a".repeat(64),
    controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    drained = new Promise<void>((resolve) => {
      release = resolve;
    }),
    service = new ExecutionService(
      new ExecutionStore(root),
      {
        async run() {
          throw Error("Unexpected execution");
        },
        async cleanup() {},
      },
      () => {},
    ),
    handler = executionHandler(service, token),
    headers = { Authorization: "Bearer " + token, "Content-Type": RESOURCE_FRAME_CONTENT_TYPE };
  try {
    const body = new ReadableStream<Uint8Array>({
        pull() {
          entered();
        },
        cancel() {
          return drained;
        },
      }),
      pending = handler(
        new Request("http://executor/v2/builds/" + randomUUID(), {
          method: "PUT",
          headers,
          body,
          signal: controller.signal,
        }),
      );
    await reading;
    controller.abort();
    const f = await resourceBuildFixture(),
      busy = await handler(
        new Request("http://executor/v2/builds/" + randomUUID(), {
          method: "PUT",
          headers,
          body: Buffer.from(encodeResourceBuild(f.request)),
        }),
      );
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: "executorBusy" });
    release();
    expect((await pending).status).toBe(409);
    expect(service.store.ids()).toEqual([]);
  } finally {
    release();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native disk quotas reject work before admission and forged input payloads never execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-build-quota-")),
    f = await resourceBuildFixture(),
    id = randomUUID();
  try {
    const small = new ExecutionStore(join(root, "small"), { maxBytes: 64, maxJobs: 1, retentionMs: 1000 });
    expect(() => small.createResource(id, f.request)).toThrow("executorStorageFull");
    expect(await readdir(join(root, "small/jobs"))).toEqual([]);
    const store = new ExecutionStore(join(root, "store"));
    store.createResource(id, f.request);
    const path = join(root, "store/jobs", id, "input.build"),
      bytes = new Uint8Array(await readFile(path));
    bytes[bytes.length - 1] = 1;
    await writeFile(path, bytes);
    await expect(store.request(id)).rejects.toThrow("inputDigestMismatch");
    await truncate(path, RESOURCE_FRAME_MAX + 1);
    await expect(store.request(id)).rejects.toThrow("invalidResourceBuild");
    await rm(path);
    await writeFile(join(root, "other.bin"), "Unrelated fixture");
    await symlink(join(root, "other.bin"), path);
    await expect(store.request(id)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary HTTP admission retains independent historical JSON limits and enforces token and media-type boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-build-limits-")),
    token = "a".repeat(64),
    service = new ExecutionService(
      new ExecutionStore(root),
      {
        async run() {
          throw Error("Unexpected execution");
        },
        async cleanup() {},
      },
      () => {},
    ),
    handler = executionHandler(service, token);
  try {
    for (const [version, maximum, type, error] of [
      ["v1", BUILD_LIMITS.inputBytes, "application/json", "inputTooLarge"],
      ["v2", RESOURCE_FRAME_MAX, RESOURCE_FRAME_CONTENT_TYPE, "resourceBuildTooLarge"],
    ] as const) {
      const result = await handler(
        new Request(`http://executor/${version}/builds/${randomUUID()}`, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, "Content-Type": type, "Content-Length": String(maximum + 1) },
          body: new Uint8Array(),
        }),
      );
      expect(result.status).toBe(413);
      expect(await result.json()).toEqual({ error });
    }
    const f = await resourceBuildFixture(),
      body = Buffer.from(encodeResourceBuild(f.request)),
      url = "http://executor/v2/builds/" + randomUUID();
    expect(
      (
        await handler(
          new Request(url, { method: "PUT", headers: { "Content-Type": RESOURCE_FRAME_CONTENT_TYPE }, body }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(
          new Request(url, {
            method: "PUT",
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body,
          }),
        )
      ).status,
    ).toBe(415);
    expect(service.store.ids()).toEqual([]);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
