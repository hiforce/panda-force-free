import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRoots, inside } from "../path-utils.js";
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

function expandImagePath(value, home) {
  const input = String(value || "").trim();
  if (!input || input.length > 8192 || input.includes("\0")) throw new Error("Invalid image path");
  if (/^file:/i.test(input)) return fileURLToPath(input);
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return resolve(home, input.slice(2));
  return input;
}

export function resolveLocalImage(
  input,
  {
    cwd = process.cwd(),
    home = process.env.HOME || process.cwd(),
    allowedRoots = [home],
    maxBytes = LOCAL_IMAGE_MAX_BYTES,
  } = {},
) {
  const expanded = expandImagePath(input, home);
  const candidate = resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
  const roots = canonicalRoots(allowedRoots);
  if (!roots.length) throw new Error("No image roots are available");

  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Image not found");
  const path = realpathSync(candidate);
  if (!roots.some((root) => inside(path, root))) throw new Error("Image is outside allowed roots");

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

  return { path, contentType, size, mtimeMs, ctimeMs, filename: basename(path) };
}
