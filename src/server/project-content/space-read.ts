import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { ProjectContentError } from "./errors.js";
import { inspectContentHeader } from "./header-reader.js";
import { projectSpaceFile } from "./paths.js";
import type { ProjectContentManifest } from "./project-manifest.js";
import type { ProjectContentView } from "./read-view.js";
import { decodeSpaceRecord } from "./space-file.js";

export function assertSpaceMembership(space: DocumentSpace, manifest: ProjectContentManifest, id: string): void {
  const library = manifest.librarySpaceId === id;
  if (
    space.id !== id ||
    space.projectId !== manifest.projectId ||
    !manifest.spaceIds.includes(id) ||
    (space.code === "__documents__") !== library ||
    (library && (space.engine !== "markdown" || space.sourceMode !== "managed"))
  )
    throw new ProjectContentError("invalidFile");
}

/** Lists and library lookups never hydrate publication profiles; opening or changing configuration validates the full file. */
export async function readSpaceMetadata(view: ProjectContentView, manifest: ProjectContentManifest, id: string) {
  const value = await view.inspect(projectSpaceFile(id), (file) =>
    inspectContentHeader(file, "space", decodeSpaceRecord),
  );
  assertSpaceMembership(value.record, manifest, id);
  return value.record;
}
