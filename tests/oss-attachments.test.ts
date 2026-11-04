import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createOssAttachmentStorage, readOssAttachmentConfig } from "../src/server/workspace/oss-attachments.js";
import { saveAttachment } from "../src/server/workspace/attachments.js";
import { attachmentsFromInput, buildComposerInput, composerInputKey, composerTextFromInput } from "../src/client/composer-attachments.js";
import { attachmentDisplayUrl, configureAttachmentUrls } from "../src/shared/attachment-urls.js";

const env = {
  PANDA_FORCE_ATTACHMENT_STORAGE: "oss", PANDA_FORCE_OSS_BUCKET: "test-europe-bucket",
  PANDA_FORCE_OSS_ACCESS_KEY_ID: "test-id", PANDA_FORCE_OSS_ACCESS_KEY_SECRET: "test-secret",
};
const config = readOssAttachmentConfig(env);
const png = readFileSync(new URL("../public/assets/panda-icon.png", import.meta.url));
const calls: any[] = [];
const fixture = () => createOssAttachmentStorage(config, {
  client: {
    async put(key, bytes, options) { calls.push({ key, bytes, options }); },
    async getStream(key) { calls.push({ method: "getStream", key }); return { stream: Readable.from([png]), res: { headers: { "content-length": String(png.length) } } }; },
    async signatureUrlV4(method, seconds, _request, key) {
      calls.push({ method, seconds, key });
      return `https://test-europe-bucket.oss-eu-central-1.aliyuncs.com/${key.split("/").map(encodeURIComponent).join("/")}?x-oss-signature=fresh`;
    },
  },
  now: () => new Date("2026-11-03T07:00:00Z"),
});
afterEach(() => { calls.length = 0; configureAttachmentUrls(); });

test("OSS configuration requires credentials, HTTPS and a bounded object directory", () => {
  expect(readOssAttachmentConfig({})).toBeNull();
  const { PANDA_FORCE_ATTACHMENT_STORAGE, ...credentialsOnly } = env;
  expect(readOssAttachmentConfig(credentialsOnly)).toBeNull();
  expect(readOssAttachmentConfig({ ...env, PANDA_FORCE_ATTACHMENT_STORAGE: "local" })).toBeNull();
  expect(createOssAttachmentStorage(null)).toBeNull();
  expect(config).toMatchObject({ region: "oss-eu-central-1", prefix: "panda-force/attachments" });
  expect(() => readOssAttachmentConfig({ ...env, PANDA_FORCE_OSS_ACCESS_KEY_SECRET: "" })).toThrow("credentials");
  expect(() => readOssAttachmentConfig({ ...env, PANDA_FORCE_OSS_ENDPOINT: "http://oss-eu-central-1.aliyuncs.com" })).toThrow("HTTPS");
  expect(() => readOssAttachmentConfig({ ...env, PANDA_FORCE_OSS_PREFIX: "../other-app" })).toThrow("prefix");
  expect(() => readOssAttachmentConfig({ ...env, PANDA_FORCE_OSS_ENDPOINT: "https://unrelated.example.com" })).toThrow("endpoint");
});

test("validated uploads go to a dated private OSS object without leaving a local file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-attachment-"));
  try {
    const storage = fixture();
    const request = Object.assign((async function* () { yield png; })(), { headers: {} });
    const attachment = await saveAttachment(request, directory, "../截图.png", storage);
    expect(attachment.storage).toBe("oss");
    expect(attachment.path).toBeUndefined();
    expect(attachment.objectKey).toBe(`panda-force/attachments/2026/11/03/${attachment.id}/截图.png`);
    expect(attachment.url).toStartWith(storage.urlPrefix);
    expect(calls[0].bytes).toEqual(png);
    expect(calls[0].options.headers["x-oss-object-acl"]).toBe("private");
    expect(calls[0].options.headers["x-oss-forbid-overwrite"]).toBe("true");
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("images send inline bytes and their original filename while history keeps OSS references", async () => {
  const storage = fixture();
  configureAttachmentUrls(storage.urlPrefix);
  const url = `${storage.urlPrefix}2026/11/03/id/notes.txt`;
  const image = { name: "截图.png", url: `${storage.urlPrefix}2026/11/03/id/%E6%88%AA%E5%9B%BE.png`, kind: "image" };
  const file = { name: "notes.txt", url, kind: "file" };
  const original = buildComposerInput("Review these", [image, file]);
  expect(original[1]).toEqual({ type: "image", url: image.url });
  const signed = await storage.prepareInput(original);
  expect(signed[1].text).toContain('Attached image: "截图.png"');
  expect(signed[1].text).toContain("x-oss-signature=fresh");
  expect(signed[2].url).toBe(`data:image/png;base64,${png.toString("base64")}`);
  expect(signed[3].text).toContain("notes.txt?x-oss-signature=fresh");
  expect(original[1].url).toBe(image.url);
  expect(calls.filter(call => call.method === "GET").every(call => call.seconds === 604800)).toBe(true);
  const displayed = storage.present({ data: [{ item: { type: "userMessage", content: signed } }] }).data[0].item.content;
  expect(attachmentsFromInput(displayed).map(a => [a.kind, a.url, a.name])).toEqual([
    ["image", image.url, "截图.png"], ["file", file.url, "notes.txt"],
  ]);
  expect(composerTextFromInput(displayed)).toBe("Review these");
  expect(composerInputKey(displayed)).toBe(composerInputKey(original));
  expect(attachmentDisplayUrl(displayed[1].url)).toBe(`/api/attachments/read?url=${encodeURIComponent(image.url)}`);
  expect(JSON.stringify(displayed)).not.toContain("data:image");
  expect(attachmentDisplayUrl("https://other.example/image.png")).toBe("https://other.example/image.png");
});

test("multiple named images survive merged native text without mixing filenames", async () => {
  const storage = fixture();
  configureAttachmentUrls(storage.urlPrefix);
  const attachments = ["正面图.png", "背面图.png"].map((name, i) => ({
    name, kind: "image", url: `${storage.urlPrefix}2026/11/03/id-${i}/${encodeURIComponent(name)}`,
  }));
  const original = buildComposerInput("Compare the named images", attachments);
  const native = await storage.prepareInput(original);
  expect(native.filter(p => p.type === "text").map(p => p.text).join("\n")).toContain('Attached image: "正面图.png"');
  expect(native.filter(p => p.type === "text").map(p => p.text).join("\n")).toContain('Attached image: "背面图.png"');
  const merged = [{ type: "text", text: native.filter(p => p.type === "text").map(p => p.text).join("\n\n") }, ...native.filter(p => p.type === "image")];
  const displayed = storage.present({ input: merged }).input;
  expect(attachmentsFromInput(displayed).map(a => a.name)).toEqual(["正面图.png", "背面图.png"]);
  expect(composerTextFromInput(displayed)).toBe("Compare the named images");
  expect(composerInputKey(displayed)).toBe(composerInputKey(original));
});

test("clipboard images without a filename suffix upload to OSS and submit inline image bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-clipboard-"));
  try {
    const storage = fixture();
    const request = Object.assign((async function* () { yield png; })(), { headers: {} });
    const attachment = await saveAttachment(request, directory, "粘贴的截图", storage);
    expect(attachment).toMatchObject({ name: "粘贴的截图", kind: "image", contentType: "image/png", storage: "oss" });
    expect(attachment.path).toBeUndefined();
    const input = await storage.prepareInput(buildComposerInput("Read this image", [attachment]));
    expect(input.some(part => part.text?.includes('Attached image: "粘贴的截图"'))).toBe(true);
    expect(input.find(part => part.type === "image").url).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid and oversized OSS images are rejected before native submission and close their streams", async () => {
  for (const oversized of [false, true]) {
    const stream = Readable.from([Buffer.from("not an image")]);
    const storage = createOssAttachmentStorage(config, { client: {
      async signatureUrlV4() { return "https://example.test/signed"; },
      async getStream() { return { stream, res: { headers: { "content-length": oversized ? String(26 * 1024 * 1024) : "12" } } }; },
    } });
    const url = `${storage.urlPrefix}2026/11/03/id/fake.png`;
    await expect(storage.prepareInput([{ type: "image", url }])).rejects.toThrow(oversized ? "25 MiB" : "supported image");
    expect(stream.destroyed).toBe(true);
  }
});

test("preview renewal cannot sign another bucket, another prefix or a traversal", async () => {
  const storage = fixture();
  const valid = `${storage.urlPrefix}2026/11/03/id/image.png`;
  expect(await storage.readUrl(valid)).toContain("x-oss-signature=fresh");
  expect(calls[0].seconds).toBe(300);
  for (const value of [
    "https://test-europe-bucket.oss-eu-central-1.aliyuncs.com/another-app/private.txt",
    valid.replace("test-europe-bucket", "other-bucket"),
    `${storage.urlPrefix}%2e%2e/secret.txt`, `${storage.urlPrefix}id/%00.txt`,
    valid.replace("https:", "http:"), valid.replace("https://", "https://user:password@"),
  ]) expect(() => storage.readUrl(value)).toThrow();
  expect(calls).toHaveLength(1);
});

test("OSS failure is visible and never falls back to a local file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-attachment-failure-"));
  const storage = createOssAttachmentStorage(config, { client: { async put() { throw { code: "AccessDenied", status: 403 }; } } });
  try {
    const request = Object.assign((async function* () { yield png; })(), { headers: {} });
    await expect(saveAttachment(request, directory, "image.png", storage)).rejects.toMatchObject({ status: 502, code: "oss_upload_failed" });
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
