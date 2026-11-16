import { assertDocumentWritable } from "../../project-content/drafts/current.js";
import { readProjectDocumentMetadata } from "../../project-content/document-metadata.js";
import { readProjectManifest } from "../../project-content/project-manifest.js";
import { readSpaceMetadata } from "../../project-content/space-read.js";
import type { ProjectContentView } from "../../project-content/read-view.js";
import { documentIdentity } from "./projects.js";

export async function requireFileDocument(view: ProjectContentView, projectId: string, documentId: string) {
  documentIdentity(documentId);
  await assertDocumentWritable(view, projectId, documentId);
  const { document } = await readProjectDocumentMetadata(view, documentId),
    manifest = await readProjectManifest(view, projectId);
  await readSpaceMetadata(view, manifest, document.spaceId);
  return document;
}
