import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { CodexTransportFactory } from "../../src/server/engines/codex-transport.js";
import { FilePackageContent } from "../../src/server/packages/content-store.js";
import {
  ImageRenderJournal,
  imageRenderIntent,
} from "../../src/server/creation/integration/rendering/image-journal.js";
import { NativeImageRenderer } from "../../src/server/creation/integration/rendering/native-image.js";
import { imageDigest, nativeImageResult } from "../../src/server/creation/integration/rendering/image-result.js";
import type { ImageRenderRequest } from "../../src/server/creation/integration/rendering/image-contracts.js";
import { isApplicationSession } from "../../src/server/engines/application-tools/sessions.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-render-"));
  directories.push(root);
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#227c9b" } })
      .png()
      .toBuffer(),
    request: ImageRenderRequest = {
      owner: "actor",
      taskId: randomUUID(),
      contextDigest: "a".repeat(64),
      slot: 1,
      prompt: "Draw a real illustration.",
      profile: { id: "default", engineId: "codex", model: "configured-model", effort: "xhigh" },
    },
    turns = new Map<string, { id: string; status: string; items: unknown[] }[]>(),
    calls: { method: string; params: Record<string, unknown> }[] = [],
    responses: object[] = [];
  let wrongProfile = false,
    supported = true,
    readFailures = 0,
    lostAcknowledgment = false,
    hold = false,
    starts = 0;
  const result = () => ({
    type: "imageGeneration",
    status: "completed",
    failure: null,
    savedPath: "/private/provider/generated/image.png",
    result: bytes.toString("base64"),
  });
  const factory: CodexTransportFactory = (options) => {
    let connected = true;
    return {
      get connected() {
        return connected;
      },
      async request(method, params = {}) {
        calls.push({ method, params });
        if (method === "modelProvider/capabilities/read") return { imageGeneration: supported, webSearch: false };
        if (method === "thread/start") {
          const id = randomUUID();
          turns.set(id, []);
          options.onMessage({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
          return {
            thread: { id },
            activePermissionProfile: { id: wrongProfile ? "default" : "panda_image_renderer" },
            approvalPolicy: "never",
            cwd: params.cwd,
          };
        }
        if (method === "turn/start") {
          starts++;
          const turn = { id: randomUUID(), status: hold ? "inProgress" : "completed", items: hold ? [] : [result()] };
          turns.get(String(params.threadId))!.push(turn);
          if (lostAcknowledgment) throw Error("The write acknowledgment was lost.");
          return { turn };
        }
        if (method === "thread/read" && readFailures-- > 0) throw Error("Transient owned-thread read failure");
        if (method === "thread/read")
          return { thread: { id: params.threadId, turns: turns.get(String(params.threadId)) } };
        return {};
      },
      sendRaw: (value) => {
        responses.push(value);
      },
      start() {},
      terminate() {
        connected = false;
      },
      fullyStopped() {
        return !connected;
      },
      cancelRestart() {},
      rejectPending() {},
    };
  };
  const journal = () => new ImageRenderJournal(join(root, "journal")),
    renderer = (timeoutMs = 1000) =>
      new NativeImageRenderer(
        journal(),
        {
          connection: { mode: "shared", socketPath: "/owned/socket" },
          scratchRoot: join(root, "native"),
          version: "test",
          timeoutMs,
        },
        factory,
      );
  return {
    root,
    bytes,
    request,
    turns,
    calls,
    responses,
    result,
    renderer,
    journal,
    starts: () => starts,
    failReads: (count: number) => {
      readFailures = count;
    },
    unsupported: () => {
      supported = false;
    },
    wrongProfile: () => {
      wrongProfile = true;
    },
    loseAcknowledgment: () => {
      lostAcknowledgment = true;
    },
    hold: () => {
      hold = true;
    },
  };
}
const callbacks = (signal = new AbortController().signal) => ({ signal, authorize: async () => {} });

test("renderer readiness coalesces read-only capability probes and fails closed without inference", async () => {
  const f = await fixture(),
    renderer = f.renderer();
  expect(await Promise.all([renderer.available(), renderer.available(), renderer.available()])).toEqual([
    true,
    true,
    true,
  ]);
  expect(await renderer.available()).toBe(true);
  expect(f.calls.filter((c) => c.method === "modelProvider/capabilities/read")).toHaveLength(1);
  f.unsupported();
  expect(await f.renderer().available()).toBe(false);
  expect(f.starts()).toBe(0);
  expect(f.calls.some((c) => c.method === "thread/start")).toBe(false);
});

test("transient polling reuses the same dispatch and uncertain reads retain the owned turn for reconciliation", async () => {
  const first = await fixture();
  first.failReads(1);
  expect((await first.renderer().render(first.request, callbacks())).bytes).toEqual(first.bytes);
  expect(first.starts()).toBe(1);
  const second = await fixture();
  second.failReads(3);
  await expect(second.renderer(3000).render(second.request, callbacks())).rejects.toThrow("uncertain");
  expect(second.calls.some((call) => call.method === "turn/interrupt")).toBe(false);
  expect((await second.renderer().render(second.request, callbacks())).bytes).toEqual(second.bytes);
  expect(second.starts()).toBe(1);
});

test("only one process links an immutable dispatch claim", async () => {
  const f = await fixture(),
    codec = {
      maxBytes: 100,
      encode: async (v: string) => Buffer.from(v),
      decode: async (b: Uint8Array) => Buffer.from(b).toString(),
      digest: imageDigest,
    },
    stores = Array.from({ length: 8 }, () => new FilePackageContent<string>(join(f.root, "claims"), codec));
  expect((await Promise.all(stores.map((s) => s.insert("owned immutable claim")))).filter(Boolean)).toHaveLength(1);
  expect(await stores[0]!.read(imageDigest("owned immutable claim"))).toBe("owned immutable claim");
});

test("completed native images are durable, coalesced and recovered without another inference", async () => {
  const f = await fixture(),
    renderer = f.renderer(),
    [a, b] = await Promise.all([renderer.render(f.request, callbacks()), renderer.render(f.request, callbacks())]);
  expect(a.bytes).toEqual(f.bytes);
  expect(b.bytes).toEqual(f.bytes);
  expect(f.starts()).toBe(1);
  a.bytes.fill(0);
  const restored = await f.renderer().render(f.request, callbacks());
  expect(restored.bytes).toEqual(f.bytes);
  expect(restored.width).toBe(32);
  expect(restored.height).toBe(24);
  expect(f.starts()).toBe(1);
  expect(f.calls.some((c) => ["fs/readFile", "thread/resume"].includes(c.method))).toBe(false);
  const policy = f.calls.find((c) => c.method === "thread/start")!.params;
  expect(policy.sandbox).toBeUndefined();
  expect(policy.permissions).toBe("panda_image_renderer");
  expect(policy.approvalPolicy).toBe("never");
  expect(policy.model).toBe("configured-model");
  expect(policy.dynamicTools).toEqual([]);
  const config = policy.config as Record<string, unknown>;
  expect(config["features.image_generation"]).toBe(true);
  expect(config["features.shell_tool"]).toBe(false);
  expect(config["features.view_image"]).toBe(false);
  expect(config.mcp_servers).toEqual({});
  const permissions = (
    config.permissions as Record<string, { filesystem: Record<string, string>; network: { enabled: boolean } }>
  ).panda_image_renderer!;
  expect(permissions.filesystem[":root"]).toBe("deny");
  expect(permissions.filesystem[String(policy.cwd)]).toBe("write");
  expect(permissions.network.enabled).toBe(false);
  if (!("threadId" in restored)) throw Error("Expected a Codex render receipt");
  expect(isApplicationSession(restored.threadId)).toBe(true);
  expect(f.responses).toContainEqual({
    id: 99,
    error: { code: -32601, message: "This renderer permits only native image generation." },
  });
  await expect(
    renderer.render({ ...f.request, prompt: "Different unauthorized reuse of the same slot." }, callbacks()),
  ).rejects.toThrow("conflict");
  expect(f.starts()).toBe(1);
});

test("competing renderer instances and lost acknowledgments reconcile the same native turn", async () => {
  const f = await fixture();
  f.loseAcknowledgment();
  const [a, b] = await Promise.all([
    f.renderer().render(f.request, callbacks()),
    f.renderer().render(f.request, callbacks()),
  ]);
  expect(a.digest).toBe(b.digest);
  expect(a.bytes).toEqual(f.bytes);
  expect(f.starts()).toBe(1);
  expect(f.calls.filter((c) => c.method === "turn/start")).toHaveLength(1);
});

test("cancellation and revoked authority fence late results; an explicit retry reads the existing result", async () => {
  const f = await fixture();
  f.hold();
  const controller = new AbortController(),
    rendering = f.renderer().render(f.request, callbacks(controller.signal));
  while (!f.starts()) await Bun.sleep(5);
  controller.abort(new Error("User cancelled"));
  await expect(rendering).rejects.toThrow("User cancelled");
  expect(await f.journal().receipt(await imageRenderIntent(f.request))).toBeNull();
  for (const turns of f.turns.values())
    for (const turn of turns) {
      turn.status = "completed";
      turn.items = [f.result()];
    }
  const recovered = await f.renderer().render(f.request, callbacks());
  expect(recovered.bytes).toEqual(f.bytes);
  expect(f.starts()).toBe(1);
  await expect(
    f.renderer().render(f.request, {
      ...callbacks(),
      authorize: async () => {
        throw Error("access revoked");
      },
    }),
  ).rejects.toThrow("access revoked");
  expect(f.starts()).toBe(1);
});

test("a dispatch whose acknowledgment and native history are still uncertain is never resubmitted", async () => {
  const f = await fixture(),
    intent = await imageRenderIntent(f.request),
    threadId = randomUUID();
  f.turns.set(threadId, []);
  await f.journal().insert(intent, "intent", intent);
  await f.journal().insert(intent, "binding", { threadId, directory: join(f.root, "native", "image-" + randomUUID()) });
  await f.journal().insert(intent, "dispatch", { threadId });
  await expect(f.renderer().render(f.request, callbacks())).rejects.toThrow();
  expect(f.starts()).toBe(0);
  await expect(f.renderer().render(f.request, callbacks())).rejects.toThrow();
  expect(f.starts()).toBe(0);
});

test("image editing supplies only verified authorized bytes and an unaccepted policy cannot dispatch", async () => {
  const f = await fixture();
  const edited = await f.renderer().render({ ...f.request, images: [f.bytes] }, callbacks());
  expect(edited.bytes).toEqual(f.bytes);
  const turn = f.calls.find((c) => c.method === "turn/start")!.params;
  expect(turn.input).toEqual([
    { type: "text", text: f.request.prompt },
    { type: "image", url: "data:image/png;base64," + f.bytes.toString("base64") },
  ]);
  const other = await fixture();
  other.wrongProfile();
  await expect(other.renderer().render(other.request, callbacks())).rejects.toThrow("unavailable");
  expect(other.starts()).toBe(0);
  expect(other.calls.some((c) => c.method === "fs/remove")).toBe(true);
});

test("status, encoding and actual raster decoding gate completion, without reading native saved paths", async () => {
  const f = await fixture();
  for (const item of [
    { ...f.result(), status: "failed" },
    { ...f.result(), failure: { message: "failed" } },
    { ...f.result(), result: "file_private_123" },
    { ...f.result(), result: Buffer.from("not a raster").toString("base64") },
    { ...f.result(), result: "abc=" },
  ])
    await expect(nativeImageResult({ status: "completed", items: [item] })).rejects.toThrow("invalidResult");
  await expect(nativeImageResult({ status: "completed", items: [f.result(), f.result()] })).rejects.toThrow(
    "invalidResult",
  );
  await expect(nativeImageResult({ status: "failed", items: [f.result()] })).rejects.toThrow("invalidResult");
  await expect(
    f.renderer().render({ ...f.request, images: [Buffer.from("forged image")] }, callbacks()),
  ).rejects.toThrow("invalidResult");
  expect(f.starts()).toBe(0);
});

test("a canceled duplicate waiter stops promptly without canceling the owned inference", async () => {
  const f = await fixture();
  f.hold();
  const renderer = f.renderer(),
    primary = renderer.render(f.request, callbacks());
  while (!f.starts()) await Bun.sleep(5);
  const controller = new AbortController(),
    duplicate = renderer.render(f.request, callbacks(controller.signal));
  await Bun.sleep(10);
  controller.abort(new Error("Duplicate view closed"));
  await expect(duplicate).rejects.toThrow("Duplicate view closed");
  for (const turns of f.turns.values())
    for (const turn of turns) {
      turn.status = "completed";
      turn.items = [f.result()];
    }
  expect((await primary).bytes).toEqual(f.bytes);
  expect(f.starts()).toBe(1);
  expect(f.calls.some((c) => c.method === "turn/interrupt")).toBe(false);
});

test("permission revocation during an active native render interrupts only its owned turn", async () => {
  const f = await fixture();
  f.hold();
  let allowed = true;
  const work = f.renderer(6000).render(f.request, {
    signal: new AbortController().signal,
    authorize: async () => {
      if (!allowed) throw Error("Owned project permission revoked");
    },
  });
  while (!f.starts()) await Bun.sleep(5);
  allowed = false;
  await expect(work).rejects.toThrow("Owned project permission revoked");
  expect(f.calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(1);
  expect(f.starts()).toBe(1);
}, 10000);
