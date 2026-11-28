import { expect, test } from "bun:test";

test("a missing terminal worker closes connections without crashing the application relay", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import assert from "node:assert/strict";
       import { mkdtemp, rm } from "node:fs/promises";
       import { createServer } from "node:http";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       import { WebSocket, WebSocketServer } from "ws";
       import { openTerminalRelay } from "./src/server/terminal/relay.ts";
       const scratch = await mkdtemp(join(tmpdir(), "panda-term-"));
       const relayPath = join(scratch, "worker.sock");
       const app = createServer();
       const proxy = new WebSocketServer({ server: app });
       proxy.on("connection", (client) => openTerminalRelay(client, relayPath, scratch));
       await new Promise((ready) => app.listen(0, "127.0.0.1", ready));
       const url = "ws://127.0.0.1:" + app.address().port;
       try {
         for (let attempt = 0; attempt < 3; attempt++) {
           const client = new WebSocket(url);
           const code = await new Promise((resolve, reject) => {
             client.once("close", resolve);
             client.on("error", reject);
           });
           assert.equal(code, 1011);
         }
         assert(app.listening);
       } finally {
         proxy.close();
         app.close();
         await rm(scratch, { recursive: true, force: true });
       }`,
    ],
    { cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => child.kill(), 8000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(error).not.toContain("Unhandled error");
    expect(code).toBe(0);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}, 10000);
