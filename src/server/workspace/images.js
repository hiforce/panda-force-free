import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { resolveLocalFile } from "./files.js";
import { attachmentImageType } from "./attachments.js";

export const LOCAL_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export function resolveLocalImage(
  input,
  {
    cwd = process.cwd(),
    home = process.env.HOME || process.cwd(),
    allowedRoots = [home],
    maxBytes = LOCAL_IMAGE_MAX_BYTES,
  } = {},
) {
  const { path, filename } = resolveLocalFile(input, { cwd, home, allowedRoots, maxBytes });

  const { size, mtimeMs, ctimeMs } = statSync(path);
  if (size > maxBytes) throw new Error("Image is too large");
  // A clipboard can omit the extension or transcode an image while retaining
  // its original filename. Prefer the image bytes over the filename's format.
  let contentType;
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(12);
    const count = readSync(fd, header, 0, header.length, 0);
    contentType = attachmentImageType(header.subarray(0, count)) || IMAGE_TYPES.get(extname(path).toLowerCase());
  } finally {
    closeSync(fd);
  }
  if (!contentType) throw new Error("Unsupported image type");

  return { path, contentType, size, mtimeMs, ctimeMs, filename };
}
