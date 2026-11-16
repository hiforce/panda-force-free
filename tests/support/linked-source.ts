import { gitBlob } from "./github-archive.js";
import { captureLinkedSourceSnapshot } from "../../src/shared/packages/sources/linked-capture.js";
import type { PackageSourceReader } from "../../src/shared/packages/sources/reader.js";

export const sourceText = (value: string) => new TextEncoder().encode(value);
/** Test sources retain independently computed Git identities for both files and raw targets. */
export function linkedSourceReader(
  files: Record<string, string | Uint8Array>,
  targets: Record<string, string | Uint8Array>,
) {
  const regular = new Map(
      Object.entries(files).map(([path, bytes]) => [path, typeof bytes === "string" ? sourceText(bytes) : bytes]),
    ),
    links = new Map(
      Object.entries(targets).map(([path, bytes]) => [path, typeof bytes === "string" ? sourceText(bytes) : bytes]),
    ),
    metadata = (source: Map<string, Uint8Array>) =>
      [...source].map(([path, bytes]) => ({
        path,
        bytes: bytes.length,
        integrity: { algorithm: "git-blob-sha1" as const, value: gitBlob(bytes) },
      })),
    reader: PackageSourceReader = {
      origin: {
        kind: "github",
        repository: "https://github.com/example/theme",
        repositoryId: 42,
        requestedRef: "main",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        root: "",
      },
      files: metadata(regular),
      links: metadata(links),
      unavailable: [...links.keys()].map((path) => ({ path, reason: "symlink" })),
      async read(path) {
        const bytes = regular.get(path) ?? links.get(path);
        if (!bytes) throw Error("Unexpected source read");
        return new Uint8Array(bytes);
      },
    };
  return reader;
}
export const linkedSource = (
  files: Record<string, string | Uint8Array>,
  targets: Record<string, string | Uint8Array>,
) => captureLinkedSourceSnapshot(linkedSourceReader(files, targets));
