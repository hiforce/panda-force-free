import { ATTACHMENT_MAX_BYTES, attachmentImageType } from "./attachments.js";
/** Download one image with a byte limit and a finite stream lifetime. */
/** @param {import("./attachment-types.js").OssObjectClient} objectClient @param {string} key */
export async function readOssAttachmentBytes(objectClient, key) {
  const result = await objectClient.getStream(key, { timeout: 30000 });
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
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}

/** The image-specific boundary retains byte validation before native inline transport. */
export async function readOssImage(objectClient, key) {
  const bytes = await readOssAttachmentBytes(objectClient, key);
  const mime = attachmentImageType(bytes);
  if (!mime) throw new Error("OSS attachment is not a supported image");
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
