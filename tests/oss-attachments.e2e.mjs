// Opt-in live OSS round trip: CODEX_WEBUI_OSS_TEST_CONFIG=/private/config.json bun tests/oss-attachments.e2e.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import OSS from "ali-oss";
import { chromium } from "playwright";
import { launchOptions } from "./browser-runtime.mjs";

const config = JSON.parse(readFileSync(process.env.CODEX_WEBUI_OSS_TEST_CONFIG, "utf8"));
const client = new OSS({ ...config, authorizationV4: true, secure: true, timeout: 15000 });
const directory = mkdtempSync(join(tmpdir(), "oss-browser-"));
const logPath = join(directory, "calls.json");
const objects = new Set();
const png = readFileSync(new URL("../public/assets/panda-icon.png", import.meta.url));
writeFileSync(join(directory, "codex"), `#!${process.execPath}
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const calls=[];
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 let result={data:[]};
 if(m.method==='initialize')result={};
 if(m.method==='account/read')result={account:null};
 if(m.method==='model/list')result={data:[{id:'gpt-test',model:'gpt-test',displayName:'GPT Test',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
 if(['turn/start','turn/steer','thread/queue/add'].includes(m.method)){
  calls.push(m);writeFileSync(${JSON.stringify(logPath)},JSON.stringify(calls));
  result=m.method==='thread/queue/add'?{queuedSubmission:{id:'oss-queue'}}:{turn:{id:'oss-turn'}};
  if(m.method==='turn/start')send({method:'item/completed',params:{threadId:m.params.threadId,turnId:'oss-turn',item:{id:'oss-native-message',clientId:m.params.clientUserMessageId,type:'userMessage',content:m.params.input}}});
 }
 send({id:m.id,result});
});
`, { mode: 0o700 });
const port = await new Promise(resolve => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "run", "src/server/main.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, HOST: "127.0.0.1", PORT: String(port),
    CODEX_HOME: directory, CODEX_WEBUI_AUTH_MODE: "none", CODEX_WEBUI_PASSWORD: "", CODEX_WEBUI_ACCESS_TOKEN: "",
    CODEX_WEBUI_APP_SERVER_MODE: "isolated", CODEX_WEBUI_ATTACHMENT_STORAGE: "oss",
    CODEX_WEBUI_OSS_BUCKET: config.bucket, CODEX_WEBUI_OSS_REGION: config.region, CODEX_WEBUI_OSS_ENDPOINT: config.endpoint,
    CODEX_WEBUI_OSS_PREFIX: "codex-webui/attachments", CODEX_WEBUI_OSS_ACCESS_KEY_ID: config.accessKeyId,
    CODEX_WEBUI_OSS_ACCESS_KEY_SECRET: config.accessKeySecret,
  }, stdout: "ignore", stderr: "ignore",
});
let browser;
try {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/health/readiness`)).ok) break; } catch {}
    await Bun.sleep(50);
  }
  browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1018, height: 760 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.config.attachmentUrlPrefix);
  await page.evaluate(() => {
    const api = globalThis.__codexWebuiDebug;
    api.startNewTask();
    api.state.active = { id: "oss-test-thread", cwd: api.state.config.defaultCwd, turns: [], canAcceptDirectInput: true };
  });
  await page.locator("#attachmentInput").setInputFiles([
    { name: "截图.png", mimeType: "image/png", buffer: png },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("OSS test notes") },
  ]);
  await page.waitForFunction(() => {
    const a = globalThis.__codexWebuiDebug.state.composerAttachments;
    return a.length === 2 && a.every(value => value.status === "ready");
  });
  const attachments = await page.evaluate(() => globalThis.__codexWebuiDebug.state.composerAttachments);
  for (const attachment of attachments) objects.add(attachment.objectKey);
  assert.ok(attachments.every(a => a.storage === "oss" && a.url.startsWith("https://") && !a.path));
  assert.equal(existsSync(join(directory, "codex-webui-uploads")), false);
  await page.waitForFunction(() => document.querySelector(".composer-attachment-preview img")?.naturalWidth > 0);
  await page.click(".composer-attachment-preview");
  await page.waitForFunction(() => document.querySelector("#imageViewerImage")?.naturalWidth > 0);
  await page.keyboard.press("Escape");
  await page.locator("#prompt").fill("Review OSS attachments");
  await page.click("#sendButton");
  for (let i = 0; i < 200 && !existsSync(logPath); i++) await Bun.sleep(25);
  const calls = JSON.parse(readFileSync(logPath, "utf8"));
  const sent = calls.find(call => call.method === "turn/start");
  assert.ok(sent, "The input must reach the app-server fixture");
  const imageUrl = sent.params.input.find(part => part.type === "image").url;
  assert.ok(imageUrl.startsWith("data:image/png;base64,"), "Codex must receive inline image bytes");
  assert.ok(sent.params.input.some(part => part.text?.includes('Attached image: "截图.png"')), "The model must receive the original image filename");
  const fileInput = sent.params.input.find(part => part.text?.startsWith('Attached file: "notes.txt"'));
  assert.ok(fileInput?.text.includes("x-oss-signature="), "Codex must receive a named signed file URL");
  const image = await fetch(imageUrl);
  assert.equal(image.status, 200);
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(png));
  const fileUrl = fileInput.text.split("\n").at(-1);
  assert.equal(await (await fetch(fileUrl)).text(), "OSS test notes");
  const redirect = await fetch(`${base}/api/attachments/read?url=${encodeURIComponent(attachments[0].url)}`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.ok(redirect.headers.get("location").includes("x-oss-signature="));
  const denied = await fetch(`${base}/api/attachments/read?url=${encodeURIComponent(attachments[0].url)}`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(denied.status, 401);
  for (const method of ["turn/steer", "thread/queue/add"]) {
    const response = await fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 50, method, params: { threadId: "oss-test-thread", input: [{ type: "image", url: attachments[0].url }] } }) });
    assert.equal((await response.json()).type, "rpc/result");
  }
  const finalCalls = JSON.parse(readFileSync(logPath, "utf8"));
  assert.ok(finalCalls.filter(call => ["turn/steer", "thread/queue/add"].includes(call.method))
    .every(call => call.params.input.some(part => part.type === "image" && part.url.startsWith("data:image/png;base64,")) && call.params.input.some(part => part.text?.includes('Attached image: "截图.png"'))));
  await page.waitForFunction(() => document.querySelector(".user-message-images img")?.naturalWidth > 0);
  assert.equal(await page.locator(".user-message-files a").textContent(), "notes.txt");
  assert.equal(await page.locator(".user-message-images img").count(), 1);
  assert.equal(await page.locator(".user-message").textContent(), "Review OSS attachments");
  assert.ok((await page.locator(".user-message-images img").getAttribute("src")).startsWith("/api/attachments/read?"), "Native image echoes must retain the small OSS preview reference");
  assert.deepEqual(errors, []);
  console.log("Live OSS upload, original filenames, inline native image inputs and compact OSS image echoes passed.");
} finally {
  await browser?.close();
  server.kill(); await server.exited;
  for (const key of objects) await client.delete(key);
  rmSync(directory, { recursive: true, force: true });
}
