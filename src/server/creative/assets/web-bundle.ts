import type { CreativeWebBundleInspection } from "../../../shared/creative/assets.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { SourceError, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import { readSourceZip } from "../../packages/zip/read.js";
import { writeSourceZip } from "../../packages/zip/write.js";
import { DocumentError } from "../../documents/errors.js";
import { ProjectContentError } from "../../project-content/errors.js";
import { creativeResourceName } from "./codec.js";

const archiveLimits: SourceLimits = Object.freeze({
  archiveBytes: limits.sourceBytes,
  fileBytes: limits.resourceBytes,
  totalBytes: limits.totalBytes,
  files: limits.resources + 1,
  entries: (limits.resources + 1) * 16,
});
async function bundleOperation<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SourceError) {
      if (error.code === "sourceTooLarge") throw new DocumentError("tooLarge", 413);
      if (error.code === "sourceCancelled") throw new DocumentError("unavailable", 503);
      throw new DocumentError("invalidInput");
    }
    if (error instanceof ProjectContentError) throw new DocumentError("invalidInput");
    throw error;
  }
}
async function open(input: Uint8Array, signal?: AbortSignal) {
  const tree = await readSourceZip(input, archiveLimits, signal);
  for (const file of tree.files) creativeResourceName(file.path);
  const entries = tree.files
    .filter((file) => /\.html$/i.test(file.path) && file.bytes > 0 && file.bytes <= limits.htmlBytes)
    .map(({ path, bytes }) => ({ name: path, size: bytes }));
  if (!entries.length) throw new DocumentError("invalidInput");
  const preferred = entries.find((entry) => entry.name.toLowerCase() === "index.html");
  const inspection: CreativeWebBundleInspection = {
    schema: 1,
    entries,
    defaultEntry: preferred?.name ?? (entries.length === 1 ? entries[0]!.name : null),
    files: tree.files.length,
    totalBytes: tree.byteLength,
  };
  return { tree, inspection };
}

/** Archive paths remain logical names; inspection never writes content or initializes a project. */
export function inspectWebBundle(input: Uint8Array, signal?: AbortSignal) {
  return bundleOperation(async () => (await open(input, signal)).inspection);
}
/** One explicitly chosen HTML entry and every other regular file enter the existing atomic original transaction. */
export function prepareWebBundle(input: Uint8Array, entry: string, signal?: AbortSignal) {
  return bundleOperation(async () => {
    const { tree, inspection } = await open(input, signal),
      name = creativeResourceName(entry);
    if (!inspection.entries.some((file) => file.name === name)) throw new DocumentError("invalidInput");
    return {
      name,
      bytes: tree.read(name),
      resources: tree.files
        .filter((file) => file.path !== name)
        .map((file) => ({
          name: file.path,
          bytes: tree.read(file.path),
        })),
    };
  });
}
/** The ZIP transport may be normalized; original file names and bytes are retained exactly. */
export function exportWebBundle(value: {
  name: string;
  bytes: Uint8Array;
  resources: { name: string; bytes: Uint8Array }[];
}) {
  return bundleOperation(() =>
    writeSourceZip(
      [
        { path: value.name, bytes: value.bytes },
        ...value.resources.map((file) => ({ path: file.name, bytes: file.bytes })),
      ],
      { ...archiveLimits, archiveBytes: limits.totalBytes + 1024 * 1024 },
    ),
  );
}
