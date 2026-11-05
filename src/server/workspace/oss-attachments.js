import OSS from "ali-oss";
import { canonicalAttachmentUrl } from "../../shared/attachment-urls.js";
import { pandaEnvironment } from "../environment.js";
import { errorCode, errorStatus } from "./../../shared/errors.js";
import { readOssImage } from "./oss-image.js";
import { createOssInputPreparer, createOssInputPresenter } from "./oss-input.js";

const INPUT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

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

/** @param {ReturnType<typeof readOssAttachmentConfig>} config @param {{client?: import("./attachment-types.js").OssObjectClient; now?: () => Date}} options */
export function createOssAttachmentStorage(config, { client, now = () => new Date() } = {}) {
  if (!config) return null;
  const objectClient = client || new OSS({ ...config, authorizationV4: true, secure: true, timeout: 30000 });
  const origin = `https://${config.bucket}.${new URL(config.endpoint).hostname}`;
  const urlPrefix = `${origin}/${config.prefix}/`;
  const urlForKey = (key) => `${origin}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const keyFromUrl = (value) => {
    const canonical = canonicalAttachmentUrl(value, urlPrefix);
    if (!canonical) throw new Error("Attachment URL is outside the configured OSS directory");
    const key = decodeURIComponent(new URL(canonical).pathname.slice(1));
    if (
      !key.startsWith(`${config.prefix}/`) ||
      // eslint-disable-next-line no-control-regex -- Reject control bytes at this security boundary.
      key.split("/").some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))
    )
      throw new Error("Invalid OSS attachment path");
    return key;
  };
  const sign = (key, expires = INPUT_URL_TTL_SECONDS) => objectClient.signatureUrlV4("GET", expires, undefined, key);
  const inlineImage = (key) => readOssImage(objectClient, key);
  const present = createOssInputPresenter(urlPrefix);
  const prepareInput = createOssInputPreparer({ urlPrefix, keyFromUrl, sign, inlineImage });
  return {
    urlPrefix,
    present,
    async put(bytes, attachment) {
      const date = now().toISOString().slice(0, 10).replaceAll("-", "/");
      const objectKey = `${config.prefix}/${date}/${attachment.id}/${attachment.name}`;
      try {
        await objectClient.put(objectKey, bytes, {
          mime: attachment.contentType,
          headers: {
            "x-oss-object-acl": "private",
            "x-oss-forbid-overwrite": "true",
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": `${attachment.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
          },
        });
      } catch (error) {
        console.warn(
          "[panda-force] OSS attachment upload failed:",
          errorCode(error) || "network_error",
          errorStatus(error) || "",
        );
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
    prepareInput,
  };
}
