import { expect, test } from "bun:test";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creationVideoProcess } from "../../src/server/creation/integration/rendering/video-process.js";
import { NativeCreationVideoRenderer } from "../../src/server/creation/integration/rendering/native-video.js";
import { creationVideoComposition } from "../../src/server/creation/integration/rendering/video-composition.js";

test("video process arguments are literal, child environment excludes application secrets, output and deadlines are bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-process-")),
    before = process.env.PANDA_VIDEO_PROOF_SECRET;
  process.env.PANDA_VIDEO_PROOF_SECRET = "synthetic-proof-secret";
  try {
    const value = "$(touch injected-file)",
      result = await creationVideoProcess(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({secret:process.env.PANDA_VIDEO_PROOF_SECRET||null,argument:process.argv.at(-1)}))",
          value,
        ],
        { cwd: root, signal: new AbortController().signal, timeoutMs: 5000 },
      );
    expect(JSON.parse(result)).toEqual({ secret: null, argument: value });
    await expect(access(join(root, "injected-file"))).rejects.toThrow();
    await expect(
      creationVideoProcess(process.execPath, ["-e", "console.log('x'.repeat(300000))"], {
        signal: new AbortController().signal,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    await expect(
      creationVideoProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
    ).rejects.toThrow();
  } finally {
    if (before === undefined) delete process.env.PANDA_VIDEO_PROOF_SECRET;
    else process.env.PANDA_VIDEO_PROOF_SECRET = before;
    await rm(root, { recursive: true, force: true });
  }
});

test("video cancellation waits for its owned process to close and permission revocation stops active work", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-process-"));
  try {
    const controller = new AbortController(),
      started = join(root, "started"),
      exited = join(root, "exited"),
      source =
        "const fs=require('node:fs');fs.writeFileSync(process.argv.at(-2),'ready');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.argv.at(-1),'closed');process.exit(0)},150));setInterval(()=>{},1000);",
      running = creationVideoProcess(process.execPath, ["-e", source, started, exited], {
        signal: controller.signal,
        timeoutMs: 10000,
      });
    void running.catch(() => {});
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await access(started);
        break;
      } catch {
        if (Date.now() > deadline) throw Error("Child did not start");
        await Bun.sleep(10);
      }
    }
    controller.abort(Error("Cancelled by proof"));
    await expect(running).rejects.toThrow("Cancelled by proof");
    expect(await readFile(exited, "utf8")).toBe("closed");
    let checks = 0;
    await expect(
      creationVideoProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        signal: new AbortController().signal,
        timeoutMs: 10000,
        authorize: async () => {
          if (++checks > 1) throw Error("Permission revoked");
        },
      }),
    ).rejects.toThrow("Permission revoked");
    expect(checks).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("video composition rejects unbounded duration, unsupported fields and multiple image sources", () => {
  const scene = { duration: 3, heading: "Actual scene", text: "Concise caption" };
  expect(creationVideoComposition({ scenes: [scene] }).aspect).toBe("landscape");
  for (const value of [
    { scenes: [{ ...scene, duration: 2 }] },
    { scenes: Array.from({ length: 12 }, () => ({ ...scene, duration: 12 })) },
    { scenes: [{ ...scene, command: "ffmpeg" }] },
    { scenes: [{ ...scene, imageHandle: "a".repeat(64), originalImage: "images/scene-0.png" }] },
    { scenes: [{ ...scene, text: "x\0y" }] },
  ])
    expect(() => creationVideoComposition(value)).toThrow();
});

test("video readiness coalesces callers, retries one cold failure and caches only a verified success for the long period", async () => {
  let calls = 0;
  let finish: ((value: boolean) => void) | undefined;
  const renderer = new NativeCreationVideoRenderer(join(tmpdir(), "video-readiness"), {}, async () => {
    if (++calls === 1) throw new DOMException("Cold process startup", "TimeoutError");
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  const first = renderer.available(),
    second = renderer.available();
  expect(first).toBe(second);
  const deadline = Date.now() + 2000;
  while (!finish) {
    if (Date.now() > deadline) throw Error("Readiness retry did not start");
    await Bun.sleep(1);
  }
  expect(calls).toBe(2);
  finish(true);
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(await renderer.available()).toBe(true);
  expect(calls).toBe(2);
});

test("unavailable video tools stay unavailable after two checks and can recover promptly after installation repair", async () => {
  let ready = false,
    calls = 0;
  const renderer = new NativeCreationVideoRenderer(join(tmpdir(), "video-readiness"), {}, async () => {
    calls++;
    return ready;
  });
  expect(await renderer.available()).toBe(false);
  expect(calls).toBe(2);
  expect(await renderer.available()).toBe(false);
  expect(calls).toBe(2);
  ready = true;
  await Bun.sleep(1100);
  expect(await renderer.available()).toBe(true);
  expect(calls).toBe(3);
});
