import { expect, test } from "bun:test";
import { FileTreeQueries } from "../../src/server/documents/files/navigation/queries.js";
import type { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import type { ProjectContentProject } from "../../src/server/project-content/project.js";
import type { ProjectContentView } from "../../src/server/project-content/read-view.js";
import { encodeProjectManifest } from "../../src/server/project-content/project-manifest.js";
import { encodeProjectDocument } from "../../src/server/project-content/document-file.js";
import { encodeProjectSpace } from "../../src/server/project-content/space-file.js";
import {
  encodeProjectNavigation,
  type ProjectNavigationTrash,
} from "../../src/server/project-content/navigation-file.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";

test("file trash pages count deleted branches, read selected metadata only and bind cursors to project snapshots", async () => {
  const files = new Map<string, Buffer>(),
    trash: ProjectNavigationTrash[] = [],
    inspected: string[] = [],
    fullReads: string[] = [],
    put = (path: string, value: string) => files.set(path, Buffer.from(value));
  put(
    "project.json",
    encodeProjectManifest({
      schema: 1,
      projectId: "project-1",
      version: 1,
      spaceIds: ["space-1"],
      librarySpaceId: "space-1",
    }),
  );
  put("spaces/space-1.panda.json", encodeProjectSpace(projectSpaceFixture("space-1", true)));
  for (let n = 0; n <= 200; n++) {
    const root = "deleted-" + String(n).padStart(3, "0");
    for (const [id, parentId, position] of [
      [root, null, 0],
      [root + "-child", root, 0],
      [root + "-leaf", root + "-child", 0],
    ] as const) {
      put("documents/" + id + ".panda.json", encodeProjectDocument(projectDocumentFixture(1, id)));
      trash.push({ documentId: id, parentId, position, operationId: root + "-operation", deletedAt: 5000 });
    }
  }
  put(
    "tree.json",
    encodeProjectNavigation({
      schema: 1,
      projectId: "project-1",
      spaces: [
        {
          spaceId: "space-1",
          version: 1,
          nodes: [],
          trash,
          origins: [],
          lastOperation: null,
        },
      ],
    }),
  );
  let commit = "a".repeat(40),
    present = true;
  const view: ProjectContentView = {
      get commit() {
        return commit;
      },
      paths: [...files.keys()],
      assertHeld() {},
      read: async (path) => {
        fullReads.push(path);
        return files.get(path) ?? null;
      },
      inspect: async (path, work) => {
        inspected.push(path);
        const bytes = files.get(path)!;
        return work({
          size: bytes.length,
          read: async (offset, length) => Buffer.from(bytes.subarray(offset, offset + length)),
        });
      },
    },
    access: Pick<DocumentFileProjects, "ifPresent"> = {
      ifPresent: async (_id, work) => (present ? work({} as ProjectContentProject, view) : null),
    },
    queries = new FileTreeQueries(access),
    first = await queries.trashPage("project-1");
  expect(first.documents).toHaveLength(200);
  expect(first.documents.every((row) => row.subtreeCount === 3)).toBe(true);
  expect(first.documents[0]!.document.id).toBe("deleted-000");
  expect(first.nextCursor).not.toBeNull();
  expect(new Set(fullReads)).toEqual(new Set(["project.json", "tree.json"]));
  expect(inspected.filter((path) => path.startsWith("documents/"))).toHaveLength(200);
  expect(inspected.some((path) => path.includes("-child") || path.includes("-leaf"))).toBe(false);
  const second = await queries.trashPage("project-1", first.nextCursor!);
  expect(second.documents.map((row) => row.document.id)).toEqual(["deleted-200"]);
  expect(second.nextCursor).toBeNull();
  await expect(queries.trashPage("project-2", first.nextCursor!)).rejects.toMatchObject({ code: "invalidInput" });
  commit = "b".repeat(40);
  await expect(queries.trashPage("project-1", first.nextCursor!)).rejects.toMatchObject({ code: "navigationConflict" });
  present = false;
  await expect(queries.trashPage("project-1", first.nextCursor!)).rejects.toMatchObject({ code: "navigationConflict" });
  expect(await queries.trashPage("project-1")).toEqual({ documents: [], nextCursor: null });
  await expect(queries.trashPage("project-1", "invalid-cursor")).rejects.toMatchObject({ code: "invalidInput" });
});
