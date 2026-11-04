// Opt-in: CODEX_WEBUI_OSS_TEST_CONFIG=/private/config.json bun tests/clipboard-oss-native.e2e.mjs
// Real browser clipboard, European OSS and native app-server; a local provider
// captures the model input without sending a request to an external model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import OSS from "ali-oss";
import { chromium } from "playwright";
import { launchOptions } from "./browser-runtime.mjs";

const config = JSON.parse(readFileSync(process.env.CODEX_WEBUI_OSS_TEST_CONFIG, "utf8"));
const client = new OSS({ ...config, authorizationV4: true, secure: true, timeout: 15000 });
const home = mkdtempSync(join(tmpdir(), "clipboard-oss-native-"));
const socket = join(home, "daemon.sock");
const png = readFileSync(new URL("../public/assets/panda-icon.png", import.meta.url));
const objects = new Set(), payloads = [], streams = [], checks = [];
const provider = createServer(async (req, res) => {
  if (!req.url.endsWith("/responses")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
  res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); streams.push(res);
});
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("IDAAS_")));
let daemon, server, browser, seq = 0;
async function waitFor(check, label) {
  for (let i = 0; i < 400; i++) { try { const value = await check(); if (value) return value; } catch {} await Bun.sleep(50); }
  throw new Error(`Clipboard verification timed out: ${label}`);
}
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  daemon = Bun.spawn(["codex", "app-server", "--listen", `unix://${socket}`,
    "-c", 'model_provider="clipboard_test"', "-c", 'model="mock"',
    "-c", 'model_providers.clipboard_test.name="Clipboard test"',
    "-c", `model_providers.clipboard_test.base_url="http://127.0.0.1:${provider.address().port}"`,
    "-c", 'model_providers.clipboard_test.wire_api="responses"',
    "-c", "model_providers.clipboard_test.requires_openai_auth=false"],
    { env: { ...env, CODEX_HOME: home }, stdout: "ignore", stderr: "ignore" });
  await waitFor(() => statSync(socket).isSocket(), "isolated native socket");
  const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "run", "src/server/main.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...env, HOST: "127.0.0.1", PORT: String(port), HOME: home, CODEX_HOME: home, CODEX_WEBUI_CWD: home,
      CODEX_WEBUI_AUTH_MODE: "none", CODEX_WEBUI_PASSWORD: "", CODEX_WEBUI_ACCESS_TOKEN: "",
      CODEX_WEBUI_APP_SERVER_MODE: "shared", CODEX_WEBUI_APP_SERVER_SOCKET: socket,
      CODEX_WEBUI_ATTACHMENT_STORAGE: "oss", CODEX_WEBUI_OSS_BUCKET: config.bucket, CODEX_WEBUI_OSS_REGION: config.region,
      CODEX_WEBUI_OSS_ENDPOINT: config.endpoint, CODEX_WEBUI_OSS_PREFIX: config.prefix || "codex-webui/attachments",
      CODEX_WEBUI_OSS_ACCESS_KEY_ID: config.accessKeyId, CODEX_WEBUI_OSS_ACCESS_KEY_SECRET: config.accessKeySecret,
    }, stdout: "ignore", stderr: "ignore",
  });
  await waitFor(async () => (await fetch(`${base}/health/readiness`)).ok, "app-server connection");
  const rpc = async (method, params) => {
    const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ++seq, method, params }) });
    const result = await response.json(); assert.equal(result.type, "rpc/result", result.error); return result.result;
  };
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(() => { if (window === window.top) { localStorage.clear(); localStorage.setItem("codex-webui-locale", "en"); } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.config.attachmentUrlPrefix);
  for (const source of ["system-clipboard", "items-only-no-extension", "nameless-image", "transcoded-original-name"]) {
    const { thread } = await rpc("thread/start", { cwd: home, model: "mock" });
    await page.evaluate(thread => {
      const api = globalThis.__codexWebuiDebug; api.startNewTask();
      api.state.active = { ...thread, turns: [], canAcceptDirectInput: true }; api.state.selectedModel = "mock";
    }, thread);
    await page.locator("#prompt").focus();
    if (source === "system-clipboard") {
      await page.evaluate(async base64 => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
      }, png.toString("base64"));
      await page.keyboard.press("Control+V");
    } else {
      await page.evaluate(({ base64, source }) => {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const name = source === "nameless-image" ? "" : source === "transcoded-original-name" ? "原照片.jpg" : "粘贴的截图";
        const file = new File([bytes], name, { type: "image/png" });
        const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", { value: { files: [], items: [{ kind: "file", type: file.type, getAsFile: () => file }] } });
        document.querySelector("#prompt").dispatchEvent(paste);
      }, { base64: png.toString("base64"), source });
    }
    await page.waitForFunction(() => {
      const a = globalThis.__codexWebuiDebug.state.composerAttachments;
      return a.length === 1 && a[0].status === "ready";
    });
    const attachment = await page.evaluate(() => globalThis.__codexWebuiDebug.state.composerAttachments[0]);
    objects.add(attachment.objectKey);
    assert.equal(attachment.kind, "image"); assert.equal(attachment.storage, "oss"); assert.equal(attachment.path, undefined);
    if (source === "items-only-no-extension") assert.equal(attachment.name, "粘贴的截图");
    if (source === "transcoded-original-name") assert.equal(attachment.name, "原照片.jpg");
    if (source === "nameless-image") assert.match(attachment.name, /^clipboard-.*\.png$/);
    await page.waitForFunction(() => document.querySelector(".composer-attachment-preview img")?.naturalWidth > 0);
    const uploaded = await client.get(attachment.objectKey);
    const before = payloads.length;
    await page.locator("#prompt").fill(`Read the pasted image: ${attachment.name}`);
    await page.locator("#sendButton").click();
    await waitFor(() => payloads.length > before, "inline image reaches the model provider");
    const body = JSON.stringify(payloads.at(-1));
    assert.ok(body.includes(`data:image/png;base64,${uploaded.content.toString("base64")}`), "The provider must receive the exact uploaded clipboard image bytes");
    assert.ok(body.includes(attachment.name)); assert.ok(body.includes("Attached image:"));
    await page.waitForFunction(() => document.querySelectorAll(".user-message-images img").length === 1 && document.querySelector(".user-message-images img").naturalWidth > 0);
    const turns = await rpc("thread/turns/list", { threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    await rpc("turn/interrupt", { threadId: thread.id, turnId: turns.data[0].id });
    checks.push({ source, filename: attachment.name, imageBytes: uploaded.content.length, inlineBytesReachProvider: true, localUploadCopy: false });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ clipboardUploadAndNativeInput: checks, browserErrors: errors }, null, 2));
} finally {
  await browser?.close();
  if (server) { server.kill(); await server.exited; }
  if (daemon) { daemon.kill(); await daemon.exited; }
  for (const stream of streams) stream.end(); provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  for (const key of objects) await client.delete(key);
  rmSync(home, { recursive: true, force: true });
}
