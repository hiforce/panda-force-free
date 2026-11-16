import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import type { ProjectPlacementFile } from "../../src/server/project-content/placement-file.js";
import { projectDocumentFixture } from "./project-document-fixture.js";
import { projectSpaceFixture, projectSpaceProfile } from "./project-space-fixture.js";

export const placementAuthor = { name: "Placement author", email: "placement@example.test" };
export function projectPlacementFixture(version = 1, id = "placement-1"): ProjectPlacementFile {
  return {
    schema: 1,
    placement: {
      id,
      projectId: "project-1",
      documentId: "doc-1",
      spaceId: "target-1",
      path: "articles/guide.md",
      locale: "en",
      revisionId: "doc-1-rev-1",
      metadata: { title: "Publication title " + version },
      version,
      createdAt: 100,
      updatedAt: 100 + version,
      deletedAt: null,
    },
    audit: { operation: version === 1 ? "create" : "update", actor: "Editor", createdAt: 101 + version },
  };
}
export async function placementFixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-placement-files-"));
  try {
    const owned = await createOwnedProjectDirectory(root, "project-1"),
      project = new ProjectContentProject(owned),
      target = projectSpaceFixture("target-1");
    target.sourceProfile = projectSpaceProfile();
    await project.spaces.put(projectSpaceFixture("space-1", true), null, "library", "library", placementAuthor);
    await project.spaces.put(target, null, "publication", "target", placementAuthor);
    await project.documents.put(projectDocumentFixture(), null, "source", placementAuthor);
    return {
      owned,
      project,
      target,
      snapshots: new ProjectGitSnapshots(owned),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
