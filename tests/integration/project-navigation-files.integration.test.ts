import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import type { ProjectNavigationState } from "../../src/server/project-content/navigation-file.js";
import { documentSubtree, moveDocumentTree } from "../../src/shared/documents/navigation.js";
import { planTreeRestore } from "../../src/shared/documents/navigation-restoration.js";

const author = { name: "Navigation author", email: "navigation@example.test" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-navigation-files-")),
    owned = await createOwnedProjectDirectory(root, "project-1"),
    project = new ProjectContentProject(owned);
  try {
    await project.spaces.put(projectSpaceFixture("space-1", true), null, "library", "library", author);
    for (const id of ["doc-1", "doc-2", "doc-3"])
      await project.documents.put(projectDocumentFixture(1, id), null, "create-" + id, author);
    const state: ProjectNavigationState = {
      spaceId: "space-1",
      version: 1,
      nodes: [
        { documentId: "doc-1", parentId: null, position: 0 },
        { documentId: "doc-2", parentId: "doc-1", position: 0 },
        { documentId: "doc-3", parentId: null, position: 1 },
      ],
      trash: [],
      origins: [{ path: "guide", documentId: "doc-1" }],
      lastOperation: null,
    };
    await project.navigation.put(state, null, "initialize", author);
    return { root, owned, project, state, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
test("file navigation retains source history across moving, subtree trash, partial restore and replay", async () => {
  const f = await fixture();
  try {
    const source = await readFile(join(f.owned.directory, "documents", "doc-1.panda.json"));
    const moved: ProjectNavigationState = {
      ...f.state,
      version: 2,
      nodes: moveDocumentTree(f.state.nodes, "doc-3", { kind: "inside", documentId: "doc-1" }),
      lastOperation: {
        id: "move",
        documentId: "doc-3",
        affectedDocumentIds: ["doc-3"],
        treeVersion: 2,
        restoredToRoot: false,
      },
    };
    await f.project.navigation.put(moved, 1, "move", author);
    const ids = documentSubtree(moved.nodes, "doc-1");
    const deleted: ProjectNavigationState = {
      ...moved,
      version: 3,
      nodes: [],
      trash: moved.nodes.map((node) => ({ ...node, deletedAt: 1200, operationId: "trash" })),
      lastOperation: {
        id: "trash",
        documentId: "doc-1",
        affectedDocumentIds: ids,
        treeVersion: 3,
        restoredToRoot: false,
      },
    };
    await f.project.navigation.put(deleted, 2, "trash", author);
    const child = planTreeRestore(
      [],
      deleted.trash.map((t) => ({ documentId: t.documentId, parentId: t.parentId, position: t.position! })),
      "doc-2",
      false,
    );
    const partial: ProjectNavigationState = {
      ...deleted,
      version: 4,
      nodes: child.next,
      trash: deleted.trash.filter((t) => !child.selected.includes(t.documentId)),
      lastOperation: {
        id: "restore-child",
        documentId: "doc-2",
        affectedDocumentIds: child.selected,
        treeVersion: 4,
        restoredToRoot: child.restoredToRoot,
      },
    };
    expect(child.restoredToRoot).toBe(true);
    await f.project.navigation.put(partial, 3, "restore-child", author);
    const parent = planTreeRestore(
      partial.nodes,
      partial.trash.map((t) => ({ documentId: t.documentId, parentId: t.parentId, position: t.position! })),
      "doc-1",
      false,
    );
    const complete: ProjectNavigationState = {
      ...partial,
      version: 5,
      nodes: parent.next,
      trash: [],
      lastOperation: {
        id: "restore-parent",
        documentId: "doc-1",
        affectedDocumentIds: parent.selected,
        treeVersion: 5,
        restoredToRoot: parent.restoredToRoot,
      },
    };
    await f.project.navigation.put(complete, 4, "restore-parent", author);
    const reopened = new ProjectContentProject(f.owned),
      snapshots = new ProjectGitSnapshots(f.owned),
      before = await snapshots.head();
    expect(await reopened.navigation.get("space-1")).toEqual(complete);
    expect(await reopened.navigation.put(deleted, 2, "trash", author)).toEqual(deleted);
    expect(await reopened.navigation.get("space-1")).toEqual(complete);
    expect(await snapshots.head()).toBe(before);
    expect((await reopened.documents.revisions("doc-1")).map((r) => r.number)).toEqual([1]);
    expect(await readFile(join(f.owned.directory, "documents", "doc-1.panda.json"))).toEqual(source);
    expect(complete.nodes.find((node) => node.documentId === "doc-3")?.parentId).toBe("doc-1");
    expect(complete.origins).toEqual([{ path: "guide", documentId: "doc-1" }]);
  } finally {
    await f.close();
  }
}, 30000);

test("navigation rejects stale queued writes and references to another space without partial state", async () => {
  const f = await fixture();
  try {
    const one: ProjectNavigationState = {
        ...f.state,
        version: 2,
        lastOperation: {
          id: "first",
          documentId: "doc-1",
          affectedDocumentIds: ["doc-1"],
          treeVersion: 2,
          restoredToRoot: false,
        },
      },
      two: ProjectNavigationState = { ...one, lastOperation: { ...one.lastOperation!, id: "second" } };
    const results = await Promise.allSettled([
      f.project.navigation.put(one, 1, "first", author),
      f.project.navigation.put(two, 1, "second", author),
    ]);
    expect(results.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
    await f.project.spaces.put(projectSpaceFixture("space-2"), null, "publication", "other-space", author);
    const foreign = projectDocumentFixture(1, "foreign-document");
    foreign.document.spaceId = "space-2";
    await f.project.documents.put(foreign, null, "foreign-document", author);
    const next: ProjectNavigationState = {
      ...one,
      version: 3,
      nodes: [...one.nodes, { documentId: "foreign-document", parentId: null, position: 2 }],
      lastOperation: {
        id: "foreign",
        documentId: "foreign-document",
        affectedDocumentIds: ["foreign-document"],
        treeVersion: 3,
        restoredToRoot: false,
      },
    };
    const snapshots = new ProjectGitSnapshots(f.owned),
      before = await snapshots.head();
    await expect(f.project.navigation.put(next, 2, "foreign", author)).rejects.toThrow("invalidFile");
    expect(await snapshots.head()).toBe(before);
    expect(await f.project.navigation.get("space-1")).toEqual(one);
    await expect(f.project.navigation.get("unknown-space")).rejects.toThrow("notFound");
  } finally {
    await f.close();
  }
}, 30000);
