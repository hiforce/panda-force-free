import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { CreationError } from "../contracts.js";
import { creationDigest, creationRecord, creationText, creationUuid } from "../validation.js";
import { authoredText } from "./authored-file-version-records.js";

export interface CreationWorkspaceExport {
  schema: 1;
  owner: string;
  taskId: string;
  outputDigest: string;
  directory: string;
  directoryIdentity?: string;
  archiveDirectory?: string;
  archiveDirectoryIdentity?: string;
  conversationId: string;
  filename: string;
  previous: string | null;
  title: string;
  markdown: string;
  images: { digest: string; extension: "png" | "jpg" | "webp" }[];
}
export const workspaceExportHash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const key = (value: Pick<CreationWorkspaceExport, "owner" | "taskId" | "outputDigest">) =>
  workspaceExportHash(stableJson({ purpose: "creation-workspace-export", ...value }));
function plan(value: unknown): CreationWorkspaceExport {
  const row = creationRecord(value, [
      "schema",
      "owner",
      "taskId",
      "outputDigest",
      "directory",
      "directoryIdentity",
      "archiveDirectory",
      "archiveDirectoryIdentity",
      "conversationId",
      "filename",
      "previous",
      "title",
      "markdown",
      "images",
    ]),
    directory = creationText(row.directory, 4096),
    filename = creationText(row.filename, 240);
  if (
    row.schema !== 1 ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    !/^[^/\\:\p{Cc}]+\.md$/u.test(filename) ||
    Buffer.byteLength(filename) > 240 ||
    typeof row.markdown !== "string" ||
    !Array.isArray(row.images) ||
    row.images.length > 1000
  )
    throw new CreationError("invalidInput");
  const images = row.images.map((value) => {
    const image = creationRecord(value, ["digest", "extension"]);
    if (!["png", "jpg", "webp"].includes(String(image.extension))) throw new CreationError("invalidInput");
    return { digest: creationDigest(image.digest), extension: image.extension as "png" | "jpg" | "webp" };
  });
  if (new Set(images.map((image) => image.digest)).size !== images.length) throw new CreationError("invalidInput");
  return {
    schema: 1,
    owner: creationText(row.owner, 200),
    taskId: creationUuid(row.taskId),
    outputDigest: creationDigest(row.outputDigest),
    directory,
    ...(row.directoryIdentity === undefined ? {} : { directoryIdentity: creationDigest(row.directoryIdentity) }),
    ...(row.archiveDirectory === undefined
      ? {}
      : {
          archiveDirectory: creationText(row.archiveDirectory, 4096),
          archiveDirectoryIdentity: creationDigest(row.archiveDirectoryIdentity),
        }),
    conversationId: creationUuid(row.conversationId),
    filename,
    previous: row.previous === null ? null : creationUuid(row.previous),
    title: creationText(row.title, 200),
    markdown: authoredText(row.markdown),
    images,
  };
}
export function creationWorkspaceExports(root: string) {
  const plans = new FilePackageContent<CreationWorkspaceExport>(root + "/plans", {
    maxBytes: 3 * 1024 * 1024,
    encode: async (value) => Buffer.from(stableJson(plan(value))),
    decode: async (bytes) => plan(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    digest: (value) => key({ owner: value.owner, taskId: value.taskId, outputDigest: value.outputDigest }),
  });
  const images = new FilePackageContent<Uint8Array>(root + "/images", {
    maxBytes: 8 * 1024 * 1024,
    extension: ".source",
    encode: async (value) => new Uint8Array(value),
    decode: async (bytes) => bytes,
    digest: workspaceExportHash,
  });
  return {
    images,
    read: async (owner: string, taskId: string, outputDigest: string) => {
      try {
        return await plans.read(key({ owner, taskId, outputDigest }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    put: async (value: CreationWorkspaceExport) => {
      const checked = plan(value);
      await plans.put(checked);
      const saved = await plans.read(
        key({ owner: value.owner, taskId: value.taskId, outputDigest: value.outputDigest }),
      );
      if (stableJson(saved) !== stableJson(checked)) throw new CreationError("conflict");
      return saved;
    },
  };
}
