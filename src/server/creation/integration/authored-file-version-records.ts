import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { FilePackageContent } from "../../packages/content-store.js";
import { stableJson } from "../../../shared/stable-json.js";
import { CreationError } from "../contracts.js";
import { creationDigest, creationInteger, creationRecord, creationText, creationUuid } from "../validation.js";

export const CREATION_AUTHORED_TEXT_BYTES = 2 * 1024 * 1024;
export const authoredDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface CreationFileVersion {
  schema: 1;
  owner: string;
  id: string;
  directory: string;
  filename: string;
  digest: string;
  bytes: number;
  previous: string | null;
}
export function authoredVersion(value: unknown): CreationFileVersion {
  const v = creationRecord(value, ["schema", "owner", "id", "directory", "filename", "digest", "bytes", "previous"]),
    directory = creationText(v.directory, 4096),
    filename = creationText(v.filename, 240),
    bytes = creationInteger(v.bytes);
  if (
    v.schema !== 1 ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    !filename ||
    Buffer.byteLength(filename) > 240 ||
    /[/\\:\p{Cc}]/u.test(filename) ||
    !/\.(md|markdown|txt)$/i.test(filename) ||
    bytes > CREATION_AUTHORED_TEXT_BYTES
  )
    throw new CreationError("invalidInput");
  return {
    schema: 1,
    owner: creationText(v.owner, 200),
    id: creationUuid(v.id),
    directory,
    filename,
    digest: creationDigest(v.digest),
    bytes,
    previous: v.previous === null ? null : creationUuid(v.previous),
  };
}
export const authoredVersionKey = (owner: string, id: string) =>
  authoredDigest(
    stableJson({ purpose: "creation-authored-version", owner: creationText(owner, 200), id: creationUuid(id) }),
  );
export function authoredText(text: string) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    /(?![\t\r\n])\p{Cc}/u.test(text) ||
    Buffer.byteLength(text) > CREATION_AUTHORED_TEXT_BYTES
  )
    throw new CreationError("invalidInput");
  return text;
}
export function authoredVersionStores(root: string) {
  const key = (v: CreationFileVersion) => authoredVersionKey(v.owner, v.id),
    codec = {
      maxBytes: 16384,
      encode: async (v: CreationFileVersion) => Buffer.from(stableJson(authoredVersion(v))),
      decode: async (bytes: Uint8Array) =>
        authoredVersion(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
      digest: key,
    };
  return {
    cleanups: new FilePackageContent(root + "/cleanups", codec),
    moves: new FilePackageContent<{
      owner: string;
      id: string;
      dev: string;
      ino: string;
      stagedDev: string;
      stagedIno: string;
    }>(root + "/moves", {
      maxBytes: 4096,
      encode: async (value) => Buffer.from(stableJson(value)),
      decode: async (bytes) => {
        const v = creationRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), [
          "owner",
          "id",
          "dev",
          "ino",
          "stagedDev",
          "stagedIno",
        ]);
        if (
          typeof v.dev !== "string" ||
          typeof v.ino !== "string" ||
          !/^\d{1,30}$/.test(v.dev) ||
          !/^\d{1,30}$/.test(v.ino) ||
          typeof v.stagedDev !== "string" ||
          typeof v.stagedIno !== "string" ||
          !/^\d{1,30}$/.test(v.stagedDev) ||
          !/^\d{1,30}$/.test(v.stagedIno)
        )
          throw new CreationError("invalidInput");
        return {
          owner: creationText(v.owner, 200),
          id: creationUuid(v.id),
          dev: v.dev,
          ino: v.ino,
          stagedDev: v.stagedDev,
          stagedIno: v.stagedIno,
        };
      },
      digest: (v) => authoredVersionKey(v.owner, v.id),
    }),
    receipts: new FilePackageContent(root + "/receipts", codec),
    inputs: new FilePackageContent<{ version: CreationFileVersion; text: string }>(root + "/inputs", {
      maxBytes: CREATION_AUTHORED_TEXT_BYTES + 16384,
      extension: ".source",
      encode: async ({ version, text }) =>
        Buffer.from(stableJson(authoredVersion(version)) + "\n" + authoredText(text)),
      decode: async (bytes) => {
        const boundary = bytes.indexOf(10);
        if (boundary < 0 || boundary > 16384) throw new CreationError("invalidInput");
        const decoder = new TextDecoder("utf-8", { fatal: true }),
          version = authoredVersion(JSON.parse(decoder.decode(bytes.subarray(0, boundary)))),
          text = authoredText(decoder.decode(bytes.subarray(boundary + 1)));
        if (authoredDigest(text) !== version.digest || Buffer.byteLength(text) !== version.bytes)
          throw new CreationError("conflict");
        return { version, text };
      },
      digest: (v) => key(v.version),
    }),
  };
}
export async function authoredOptional<T>(store: FilePackageContent<T>, key: string) {
  try {
    return await store.read(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
