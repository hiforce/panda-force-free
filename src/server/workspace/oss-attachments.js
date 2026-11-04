import { pandaEnvironment } from "../environment.js";
import OSS from "ali-oss";
import { attachmentUrlName, canonicalAttachmentUrl } from "../../shared/attachment-urls.js";
import { ATTACHMENT_MAX_BYTES, attachmentImageType } from "./attachments.js";

const INPUT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
// Leave room below the daemon's 64 MiB message limit for the RPC envelope.
const MAX_INLINE_INPUT_BYTES = 60 * 1024 * 1024;
const IMAGE_REFERENCE = /^Attached image: ("[^\n]*")\n(https:\/\/[^\n]+)$/gm;

export function readOssAttachmentConfig(env = process.env) {
  env = pandaEnvironment(env);
  const mode = env.PANDA_FORCE_ATTACHMENT_STORAGE || "local";
  if (mode === "local") return null;
  if (mode !== "oss") throw new Error("PANDA_FORCE_ATTACHMENT_STORAGE must be local or oss");
  const bucket = env.PANDA_FORCE_OSS_BUCKET;
  const region = env.PANDA_FORCE_OSS_REGION || "oss-eu-central-1";
  const accessKeyId = env.PANDA_FORCE_OSS_ACCESS_KEY_ID;
  const accessKeySecret = env.PANDA_FORCE_OSS_ACCESS_KEY_SECRET;
  if (!bucket || !accessKeyId || !accessKeySecret) throw new Error("OSS bucket and access credentials are required");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^oss-[a-z0-9-]+$/.test(region))
    throw new Error("Invalid OSS bucket or region");
  const endpoint = env.PANDA_FORCE_OSS_ENDPOINT || `https://${region}.aliyuncs.com`;
  const target = new URL(endpoint);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    target.search ||
    target.hash ||
    target.pathname !== "/" ||
    target.hostname !== `${region}.aliyuncs.com`
  )
    throw new Error("OSS endpoint must be the HTTPS public endpoint for its region");
  const prefix = (env.PANDA_FORCE_OSS_PREFIX || "panda-force/attachments").replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !/^[a-zA-Z0-9_-]+$/.test(part)))
    throw new Error("Invalid OSS attachment prefix");
  return {
    bucket,
    region,
    endpoint: target.origin,
    prefix,
    accessKeyId,
    accessKeySecret,
    stsToken: env.PANDA_FORCE_OSS_SECURITY_TOKEN || undefined,
  };
}

export function createOssAttachmentStorage(config, { client, now = () => new Date() } = {}) {
  if (!config) return null;
  client ||= new OSS({ ...config, authorizationV4: true, secure: true, timeout: 30000 });
  const origin = `https://${config.bucket}.${new URL(config.endpoint).hostname}`;
  const urlPrefix = `${origin}/${config.prefix}/`;
  const urlForKey = (key) => `${origin}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const keyFromUrl = (value) => {
    const canonical = canonicalAttachmentUrl(value, urlPrefix);
    if (!canonical) throw new Error("Attachment URL is outside the configured OSS directory");
    const key = decodeURIComponent(new URL(canonical).pathname.slice(1));
    if (
      !key.startsWith(`${config.prefix}/`) ||
      key.split("/").some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))
    )
      throw new Error("Invalid OSS attachment path");
    return key;
  };
  const sign = (key, expires = INPUT_URL_TTL_SECONDS) => client.signatureUrlV4("GET", expires, undefined, key);
  const inlineImage = async (key) => {
    const result = await client.getStream(key, { timeout: 30000 });
    const stream = result.stream;
    if (!stream) throw new Error("OSS image is unavailable");
    const timer = setTimeout(() => stream.destroy(new Error("OSS image download timed out")), 30000);
    timer.unref?.();
    try {
      if (Number(result.res?.headers?.["content-length"]) > ATTACHMENT_MAX_BYTES)
        throw new Error("Each attachment must be 25 MiB or smaller");
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > ATTACHMENT_MAX_BYTES) throw new Error("Each attachment must be 25 MiB or smaller");
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      const mime = attachmentImageType(bytes);
      if (!mime) throw new Error("OSS attachment is not a supported image");
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  };
  const presentInput = (input) => {
    const references = [];
    for (const part of input) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      for (const match of part.text.matchAll(IMAGE_REFERENCE)) {
        const url = canonicalAttachmentUrl(match[2], urlPrefix);
        if (!url) continue;
        try {
          if (JSON.parse(match[1]) === attachmentUrlName(url)) references.push({ url, marker: match[0] });
        } catch {
          /* Unrelated text is not attachment metadata. */
        }
      }
    }
    const images = input.filter((part) => part?.type === "image" && /^data:image\//i.test(part.url || ""));
    if (!references.length || images.length !== references.length) return input;
    let imageIndex = 0;
    return input.flatMap((part) => {
      if (part?.type === "image" && /^data:image\//i.test(part.url || ""))
        return [{ ...part, url: references[imageIndex++].url }];
      if (part?.type !== "text" || typeof part.text !== "string") return [part];
      let text = part.text;
      for (const reference of references) text = text.replaceAll(reference.marker, "");
      if (text === part.text) return [part];
      return text.trim() ? [{ ...part, text: text.trim() }] : [];
    });
  };
  const present = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const input = presentInput(value);
      let changed = input !== value;
      const result = input.map((item) => {
        const next = present(item);
        changed ||= next !== item;
        return next;
      });
      return changed ? result : value;
    }
    let result = value;
    for (const [key, child] of Object.entries(value)) {
      const next = present(child);
      if (next !== child) {
        if (result === value) result = { ...value };
        result[key] = next;
      }
    }
    return result;
  };
  return {
    urlPrefix,
    present,
    async put(bytes, attachment) {
      const date = now().toISOString().slice(0, 10).replaceAll("-", "/");
      const objectKey = `${config.prefix}/${date}/${attachment.id}/${attachment.name}`;
      try {
        await client.put(objectKey, bytes, {
          mime: attachment.contentType,
          headers: {
            "x-oss-object-acl": "private",
            "x-oss-forbid-overwrite": "true",
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": `${attachment.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
          },
        });
      } catch (error) {
        console.warn("[panda-force] OSS attachment upload failed:", error.code || "network_error", error.status || "");
        throw Object.assign(new Error("OSS upload failed; try again later"), {
          code: "oss_upload_failed",
          status: 502,
        });
      }
      return { storage: "oss", objectKey, url: urlForKey(objectKey) };
    },
    readUrl(value) {
      return sign(keyFromUrl(value), 300);
    },
    async prepareInput(input) {
      if (!Array.isArray(input)) return input;
      const signed = new Map();
      const images = new Map();
      const refresh = (value) => {
        if (!canonicalAttachmentUrl(value, urlPrefix)) return Promise.resolve(value);
        const key = keyFromUrl(value);
        if (!signed.has(key)) signed.set(key, sign(key));
        return signed.get(key);
      };
      const prepared = [];
      let inputBytes = 2;
      for (const part of input) {
        let parts;
        if (part?.type === "image" && canonicalAttachmentUrl(part.url, urlPrefix)) {
          const key = keyFromUrl(part.url);
          if (!images.has(key)) images.set(key, inlineImage(key));
          const [url, source] = await Promise.all([images.get(key), refresh(part.url)]);
          parts = [
            { type: "text", text: `Attached image: ${JSON.stringify(attachmentUrlName(part.url))}\n${source}` },
            { ...part, url },
          ];
        } else if (part?.type === "text" && typeof part.text === "string") {
          let text = part.text;
          for (const match of part.text.matchAll(/^Attached file: (".*")\n([^\n]+)$/gm)) {
            try {
              JSON.parse(match[1]);
            } catch {
              continue;
            }
            const url = await refresh(match[2]);
            text = text.replace(match[0], `Attached file: ${match[1]}\n${url}`);
          }
          parts = [{ ...part, text }];
        } else parts = [part];
        for (const value of parts) {
          inputBytes += Buffer.byteLength(JSON.stringify(value) || "null") + 1;
          if (inputBytes > MAX_INLINE_INPUT_BYTES)
            throw new Error("Combined image inputs are too large; send fewer images at a time");
          prepared.push(value);
        }
      }
      return prepared;
    },
  };
}
