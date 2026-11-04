import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createCodexBridge } from "../src/server/bridge/codex-process.ts";

async function fixture(reply: (message: any, socket: any) => void, initializeDelay = 0) {
  const directory = mkdtempSync(join(tmpdir(), "panda-bridge-"));
  const socketPath = join(directory, "daemon.sock");
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "initialize")
      setTimeout(() => socket.send(JSON.stringify({ id: message.id, result: {} })), initializeDelay);
    else if (message.id !== undefined) reply(message, socket);
  }));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  let stopping = false;
  const bridge = createCodexBridge({
    connection: { mode: "shared", socketPath }, defaultCwd: directory,
    clientInfo: { name: "bridge_test", title: "Bridge test", version: "1" },
    isShuttingDown: () => stopping, onMessage: () => {}, onConnected: () => {}, onDisconnected: () => {},
  });
  return {
    bridge,
    async close() {
      stopping = true;
      bridge.cancelRestart();
      bridge.rejectPending(new Error("Test shutdown"));
      bridge.terminate();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("requests arriving during the initial handshake wait for the daemon", async () => {
  const f = await fixture((message, socket) => socket.send(JSON.stringify({ id: message.id, result: { data: [] } })), 50);
  try {
    expect(await f.bridge.request("thread/list")).toEqual({ data: [] });
    expect(f.bridge.connected).toBe(true);
  } finally { await f.close(); }
});

test("a disconnected read recovers after one shared daemon reconnect", async () => {
  let reads = 0;
  const f = await fixture((message, socket) => {
    if (++reads === 1) socket.terminate();
    else socket.send(JSON.stringify({ id: message.id, result: { data: ["thread"] } }));
  });
  try {
    expect(await f.bridge.request("thread/list")).toEqual({ data: ["thread"] });
    expect(reads).toBe(2);
  } finally { await f.close(); }
});

test("a lost turn acknowledgement never causes the input to be sent again", async () => {
  let inputs = 0;
  const f = await fixture((_message, socket) => { inputs++; socket.terminate(); });
  try {
    await expect(f.bridge.request("turn/start", { threadId: "A", input: [{ type: "text", text: "Once" }] }))
      .rejects.toMatchObject({ code: "codex_disconnected" });
    await Bun.sleep(1100);
    expect(inputs).toBe(1);
    expect(f.bridge.connected).toBe(true);
  } finally { await f.close(); }
});

test("a repeatedly failing read stops after one recovery attempt", async () => {
  let reads = 0;
  const f = await fixture((_message, socket) => { reads++; socket.terminate(); });
  try {
    await expect(f.bridge.request("thread/list")).rejects.toMatchObject({ code: "codex_disconnected" });
    expect(reads).toBe(2);
  } finally { await f.close(); }
});

test("an oversized response is reported without repeating the same oversized query", async () => {
  let reads = 0;
  const f = await fixture((_message, socket) => { reads++; socket.close(1009, "Message too big"); });
  try {
    await expect(f.bridge.request("thread/read", { threadId: "large", includeTurns: true }))
      .rejects.toMatchObject({ code: "codex_response_too_large" });
    expect(reads).toBe(1);
  } finally { await f.close(); }
});
