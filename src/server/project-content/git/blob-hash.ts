import { createHash } from "node:crypto";

/** Matches the explicitly selected SHA-1 Git object format, without invoking filters or reading an index. */
export const projectBlobHash = (bytes: Buffer): string =>
  createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
