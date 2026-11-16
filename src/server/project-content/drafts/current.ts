import { decodeProjectDocument } from "../document-file.js";
import { ProjectContentError } from "../errors.js";
import { decodeProjectNavigation } from "../navigation-file.js";
import { projectDocumentFile } from "../paths.js";
import { readProjectManifest } from "../project-manifest.js";
import type { ProjectContentView } from "../read-view.js";
import { readSpaceMetadata } from "../space-read.js";

export async function readSavedDocument(view: ProjectContentView, projectId: string, id: string) {
  const bytes = await view.read(projectDocumentFile(id));
  if (bytes === null) throw new ProjectContentError("notFound");
  const detail = decodeProjectDocument(bytes),
    manifest = await readProjectManifest(view, projectId);
  if (detail.document.id !== id) throw new ProjectContentError("invalidFile");
  await readSpaceMetadata(view, manifest, detail.document.spaceId);
  return detail;
}
export async function assertDocumentWritable(view: ProjectContentView, projectId: string, id: string) {
  const bytes = await view.read("tree.json");
  if (bytes === null) return;
  const tree = decodeProjectNavigation(bytes);
  if (tree.projectId !== projectId) throw new ProjectContentError("invalidFile");
  if (tree.spaces.some((state) => state.trash.some((row) => row.documentId === id)))
    throw new ProjectContentError("notFound");
}
