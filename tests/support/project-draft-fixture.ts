import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectDraftCommand } from "../../src/server/project-content/drafts/store.js";
import type { ProjectDraftContent } from "../../src/server/project-content/drafts/content.js";
import type { DocumentDetail } from "../../src/shared/documents/contracts.js";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectDocumentFixture } from "./project-document-fixture.js";
import { projectSpaceFixture } from "./project-space-fixture.js";

export const draftAuthor = { name: "Document editor", email: "editor@example.test" };
export async function projectDraftFixture(detail: DocumentDetail = projectDocumentFixture()) {
  const root = await mkdtemp(join(tmpdir(), "panda-document-drafts-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "project-1"),
      project = new ProjectContentProject(owned);
    await project.spaces.put(projectSpaceFixture("space-1", true), null, "library", "library", draftAuthor);
    await project.documents.put(detail, null, "initial-document", draftAuthor);
    return {
      owned,
      project,
      detail,
      snapshots: new ProjectGitSnapshots(owned),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export function autosaveCommand(
  operationId = "autosave-1",
  expectedVersion = 0,
  baseRevisionId = "doc-1-rev-1",
): ProjectDraftCommand & { content: ProjectDraftContent } {
  return {
    documentId: "doc-1",
    expectedVersion,
    baseRevisionId,
    operationId,
    actor: "user:editor",
    content: { title: "Working draft", locale: "en", content: "Unsaved source", resources: [] },
  };
}
export const checkpointCommand = (
  operationId = "checkpoint-1",
  expectedDraftVersion = 1,
  expectedRevisionId = "doc-1-rev-1",
) => ({ documentId: "doc-1", expectedDraftVersion, expectedRevisionId, operationId, author: { ...draftAuthor } });
