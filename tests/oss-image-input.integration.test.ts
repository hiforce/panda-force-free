import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createCodexBridge } from "../src/server/bridge/codex-process.ts";
import { createOssAttachmentStorage } from "../src/server/workspace/oss-attachments.js";

async function waitFor(check: () => any) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = check(); if (value) return value; await Bun.sleep(25); }
  throw new Error("Native image input verification timed out");
}

test("real app-server accepts inline OSS images and forwards original filenames to the provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "oss-native-image-"));
  const responses: any[] = [], payloads: any[] = [], events: any[] = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); responses.push(res);
  });
  let daemon: any, stopping = false;
  const socketPath = join(home, "daemon.sock");
  const bridge = createCodexBridge({
    connection: { mode: "shared", socketPath }, defaultCwd: home,
    clientInfo: { name: "oss_image_test", title: "OSS image test", version: "1" },
    isShuttingDown: () => stopping, onMessage: message => events.push(message), onConnected: () => {}, onDisconnected: () => {},
  });
  try {
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as any).port;
    daemon = Bun.spawn(["codex", "app-server", "--listen", `unix://${socketPath}`,
      "-c", 'model_provider="inline_test"', "-c", 'model="mock"',
      "-c", 'model_providers.inline_test.name="Inline test"',
      "-c", `model_providers.inline_test.base_url="http://127.0.0.1:${port}"`,
      "-c", 'model_providers.inline_test.wire_api="responses"',
      "-c", "model_providers.inline_test.requires_openai_auth=false"],
      { env: { ...process.env, CODEX_HOME: home }, stdout: "ignore", stderr: "ignore" });
    const { thread } = await bridge.request("thread/start", { cwd: home, model: "mock" });
    await expect(bridge.request("turn/start", { threadId: thread.id,
      input: [{ type: "image", url: "https://example.com/original.png" }] }))
      .rejects.toThrow("remote image URLs are not supported");

    const png = readFileSync(new URL("../public/assets/panda-icon.png", import.meta.url));
    const large = Buffer.concat([png, Buffer.alloc(25 * 1024 * 1024 - png.length)]);
    const storage = createOssAttachmentStorage({ bucket: "native-test-bucket", region: "oss-eu-central-1",
      endpoint: "https://oss-eu-central-1.aliyuncs.com", prefix: "codex-webui/attachments" }, { client: {
      async getStream(key) { const bytes = key.endsWith("大图原名.png") ? large : png; return { stream: Readable.from([bytes]), res: { headers: { "content-length": String(bytes.length) } } }; },
      async signatureUrlV4(_method, _seconds, _request, key) { return `https://native-test-bucket.oss-eu-central-1.aliyuncs.com/${key.split("/").map(encodeURIComponent).join("/")}?signature=test`; },
    } });
    const names = ["正面图.png", "背面图.png"];
    const input = await storage.prepareInput([{ type: "text", text: "Compare by the original filenames" },
      ...names.map((name, i) => ({ type: "image", url: `${storage.urlPrefix}2026/11/03/id-${i}/${encodeURIComponent(name)}` }))]);
    const started = await bridge.request("turn/start", { threadId: thread.id, input });
    await waitFor(() => payloads.length > 0);
    const body = JSON.stringify(payloads[0]);
    expect(body).toContain(`data:image/png;base64,${png.toString("base64")}`);
    for (const name of names) expect(body).toContain(name);
    expect(body).toContain("Attached image:");
    const echo = await waitFor(() => events.find(event => event.params?.item?.type === "userMessage" && JSON.stringify(event.params.item).includes("正面图.png")));
    const displayed = storage.present(echo).params.item.content;
    expect(displayed.filter(part => part.type === "image").map(part => part.url)).toEqual(
      names.map((name, i) => `${storage.urlPrefix}2026/11/03/id-${i}/${encodeURIComponent(name)}`),
    );
    expect(JSON.stringify(displayed).includes("data:image")).toBe(false);
    await bridge.request("turn/interrupt", { threadId: thread.id, turnId: started.turn.id });

    const clipboardPath = join(home, "剪贴板原图");
    writeFileSync(clipboardPath, png);
    const beforeClipboard = payloads.length;
    const clipboardTurn = await bridge.request("turn/start", { threadId: thread.id,
      input: [{ type: "localImage", path: clipboardPath }] });
    await waitFor(() => payloads.length > beforeClipboard);
    expect(JSON.stringify(payloads.at(-1))).toContain(`data:image/png;base64,${png.toString("base64")}`);
    await bridge.request("turn/interrupt", { threadId: thread.id, turnId: clipboardTurn.turn.id });

    const largeInput = await storage.prepareInput([{ type: "image", url: `${storage.urlPrefix}2026/11/03/large/${encodeURIComponent("大图原名.png")}` }]);
    const before = payloads.length;
    const largeTurn = await bridge.request("turn/start", { threadId: thread.id, input: largeInput });
    await waitFor(() => payloads.length > before);
    expect(JSON.stringify(payloads.at(-1))).toContain("大图原名.png");
    expect(bridge.connected).toBe(true);
    await bridge.request("turn/interrupt", { threadId: thread.id, turnId: largeTurn.turn.id });
  } finally {
    stopping = true; bridge.cancelRestart(); bridge.rejectPending(new Error("Test shutdown")); bridge.terminate();
    daemon?.kill(); if (daemon) await daemon.exited;
    for (const response of responses) response.end();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 45000);
