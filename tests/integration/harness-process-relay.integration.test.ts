import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessStdioTransport } from "../../src/server/harness/adapters/stdio.js";
import { createCodexBridge } from "../../src/server/bridge/codex-process.js";
import { captureNativeProcess, nativeProcessScratch } from "../../src/server/engines/native-process.js";

test("a gateway configured for media cannot start a local Harness without its process worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pf-native-isolation-"));
  const marker = join(dir, "launched");
  const settings = {
    PANDA_FORCE_HARNESS_PROCESS_SOCKET: undefined,
    PANDA_FORCE_MEDIA_EXECUTOR_SOCKET: join(dir, "media.sock"),
    PANDA_FORCE_MEDIA_EXECUTOR_TOKEN_FILE: join(dir, "token"),
  };
  const original = Object.keys(settings).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const transport = new HarnessStdioTransport({
    command: process.execPath,
    args: ["-e", "await Bun.write(" + JSON.stringify(marker) + ", 'started');"],
    cwd: dir,
    env: {},
  });
  const codex = {
    defaultCwd: dir,
    clientInfo: { name: "fixture", title: "Fixture", version: "test" },
    isShuttingDown: () => false,
    onMessage() {},
    onConnected() {},
    onDisconnected() {},
  };
  try {
    await expect(transport.request("initialize", {}, 1000)).rejects.toMatchObject({
      code: "unavailable",
      dispatched: false,
    });
    await expect(nativeProcessScratch()).rejects.toThrow("A separate Harness process worker");
    expect(() => createCodexBridge({ ...codex, connection: { mode: "isolated" } })).toThrow(
      "A separate Harness process worker",
    );
    expect(() =>
      createCodexBridge({ ...codex, connection: { mode: "shared", socketPath: join(dir, "codex.sock") } }),
    ).not.toThrow();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("native launches wait for the worker and keep gateway credentials off the wire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pf-native-relay-"));
  const socketPath = join(dir, "worker.sock");
  const savedSocket = process.env.PANDA_FORCE_HARNESS_PROCESS_SOCKET;
  process.env.PANDA_FORCE_HARNESS_PROCESS_SOCKET = socketPath;
  const clients = new Set<Socket>();
  const relay = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.once("data", (data) => {
      expect(JSON.parse(data.toString())).toEqual({
        command: "fixture",
        args: ["stdio"],
        cwd: dir,
        env: { HOME: dir },
      });
      socket.write(Buffer.from([1]));
      socket.once("data", (request) => {
        const { id } = JSON.parse(request.toString());
        socket.write(JSON.stringify({ id, jsonrpc: "2.0", result: { model: "測試" } }) + "\n");
      });
    });
  });
  const plan = {
    command: "fixture",
    args: ["stdio"],
    cwd: dir,
    env: { HOME: dir, PANDA_FORCE_MEDIA_EXECUTOR_TOKEN: "not-a-real-secret", OPENAI_API_KEY: "not-a-real-key" },
  };
  const native = new HarnessStdioTransport(plan);
  try {
    await new Promise<void>((resolve) => relay.listen(socketPath, resolve));
    await expect(native.request("initialize", {}, 1000)).resolves.toEqual({ model: "測試" });
    await native.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    const disconnected = new HarnessStdioTransport(plan);
    await expect(disconnected.request("initialize", {}, 1000)).rejects.toMatchObject({
      code: "unavailable",
      dispatched: false,
    });
    await disconnected.close();
  } finally {
    if (savedSocket === undefined) delete process.env.PANDA_FORCE_HARNESS_PROCESS_SOCKET;
    else process.env.PANDA_FORCE_HARNESS_PROCESS_SOCKET = savedSocket;
    await native.close();
    for (const socket of clients) socket.destroy();
    if (relay.listening) await new Promise<void>((resolve) => relay.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a finite native launch requires a complete exit-status receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pf-native-capture-"));
  const path = join(dir, "worker.sock");
  let truncate = false;
  const relay = createServer((socket) => {
    socket.once("data", (data) => {
      expect(JSON.parse(data.toString()).capture).toEqual({ inputBytes: 3, outputBytes: 64 });
      socket.write(Buffer.from([1]));
      socket.once("data", (input) => {
        expect(input.toString()).toBe("abc");
        socket.end(Buffer.from(truncate ? [0, 0, 0, 0, 3, 97] : [0, 0, 0, 0, 3, 97, 98, 99]));
      });
    });
  });
  try {
    await new Promise<void>((resolve) => relay.listen(path, resolve));
    const run = () =>
      captureNativeProcess(
        path,
        { command: "fixture", args: [], cwd: dir, env: {} },
        Buffer.from("abc"),
        64,
        AbortSignal.timeout(1000),
      );
    expect((await run()).toString()).toBe("abc");
    truncate = true;
    await expect(run()).rejects.toThrow("Harness capture did not complete");
  } finally {
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
