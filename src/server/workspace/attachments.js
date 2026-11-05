import { readRequestBytes, RequestBodyError } from "../request-bytes.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const imageTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export function attachmentImageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

/** @param {import("node:http").IncomingMessage} request @param {string} root @param {string | null} originalName @param {import("./attachment-types.js").AttachmentStorage | null} storage */
export async function saveAttachment(request, root, originalName, storage = null) {
  const name = basename(String(originalName || "").replaceAll("\\", "/"))
    // eslint-disable-next-line no-control-regex -- Reject control bytes at this security boundary.
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (!name || name === "." || name === ".." || Buffer.byteLength(name) > 240)
    throw new Error("Invalid attachment filename");
  let bytes;
  try {
    bytes = await readRequestBytes(request, ATTACHMENT_MAX_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413)
      throw Object.assign(new Error("Each attachment must be 25 MiB or smaller"), { status: 413 });
    throw error;
  }
  const size = bytes.length;
  if (!size) throw new Error("Cannot upload an empty file");
  const detected = attachmentImageType(bytes),
    expected = imageTypes.get(extname(name).toLowerCase());
  if (expected && !detected) throw new Error("Image content does not match its file type");
  const id = randomUUID();
  const attachment = {
    id,
    name,
    size,
    kind: detected ? "image" : "file",
    contentType: detected || "application/octet-stream",
    status: "ready",
  };
  if (storage) return { ...attachment, ...(await storage.put(bytes, attachment)) };
  const directory = join(root, id),
    path = join(directory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  // Classify validated image bytes even when a clipboard filename has no suffix.
  return { ...attachment, path };
}
