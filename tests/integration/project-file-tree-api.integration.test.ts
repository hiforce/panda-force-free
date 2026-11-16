import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyRichBody } from "../../src/shared/documents/rich-body.js";
import { findOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectGit } from "../../src/server/project-content/git/process.js";
import { ProjectContentPlan } from "../../src/server/project-content/plan-view.js";
import { ProjectContentJournal } from "../../src/server/project-content/journal.js";
import { withProjectGitLease } from "../../src/server/project-content/git/lease.js";
import { syncContentDirectory } from "../../src/server/project-content/working-files.js";
import { navigationRequest } from "../../src/server/documents/navigation/validation.js";
import { draftAuthor } from "../support/project-draft-fixture.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

const projectId = "new-project",
  treePath = "/api/project-document-tree?project=" + projectId,
  createPath = "/api/project-document-tree/documents",
  actionsPath = "/api/project-document-tree/actions",
  trashPath = "/api/project-document-tree/trash?project=" + projectId;
const create = (treeVersion = 0, title = "Root", parentId: string | null = null) => ({
  id: randomUUID(),
  projectId,
  treeVersion,
  title,
  parentId,
  locale: "en",
});
const action = (kind: string, treeVersion: number, documentId: string, extra: Record<string, unknown> = {}) => ({
  action: kind,
  id: randomUUID(),
  projectId,
  treeVersion,
  documentId,
  ...extra,
});
const source = (id: string) => "/api/project-documents/source?project=" + projectId + "&id=" + id;
const editor = (id: string) => "/api/project-documents/editor?project=" + projectId + "&id=" + id;
async function content(f: Awaited<ReturnType<typeof projectFileApiFixture>>) {
  const owned = (await findOwnedProjectDirectory(f.root, projectId))!;
  return { owned, project: new ProjectContentProject(owned), snapshots: new ProjectGitSnapshots(owned) };
}

test.concurrent(
  "the first file-tree create atomically establishes library, source, placement and operation receipt",
  async () => {
    const f = await projectFileApiFixture();
    f.grants.add(projectId);
    try {
      const before = await readdir(join(f.root, "projects"));
      expect((await f.call(treePath)).body).toEqual({ projectId, version: 0, nodes: [] });
      expect((await f.call(trashPath)).body).toEqual({ documents: [], nextCursor: null });
      expect(await readdir(join(f.root, "projects"))).toEqual(before);
      const command = create(),
        first = await f.call(createPath, "POST", command);
      expect(first.status).toBe(201);
      expect(first.body.tree).toMatchObject({ projectId, version: 1 });
      expect(first.body.tree.nodes).toHaveLength(1);
      const id = first.body.operation.documentId,
        c = await content(f),
        head = await c.snapshots.head();
      expect(first.body.operation).toMatchObject({ id: command.id, affectedDocumentIds: [id], treeVersion: 1 });
      expect((await f.call(source(id))).body).toMatchObject({
        engine: "markdown",
        sourceMode: "managed",
        document: { id, title: command.title, revision: 1 },
      });
      expect((await c.snapshots.entries(head)).map((row) => row.path)).toHaveLength(5);
      expect(
        (await projectGit(c.owned.directory, ["log", "--format=%H", "refs/heads/content"]))
          .toString()
          .trim()
          .split("\n"),
      ).toHaveLength(2);
      const receipt = await c.project.navigationOperations.get(command.id);
      expect(receipt).toMatchObject({ owner: "operator:test-user", result: first.body.operation });
      expect(receipt?.request).toMatch(/^[a-f0-9]{64}$/);
      f.reopen();
      expect((await f.call(createPath, "POST", command)).body).toEqual(first.body);
      expect(await c.snapshots.head()).toBe(head);
      f.actor("operator:test-user");
      f.grants.delete(projectId);
      expect((await f.call(treePath)).status).toBe(404);
      expect(
        (await f.call(actionsPath, "POST", action("rename", 1, id, { title: "Denied", revision: 1 }))).status,
      ).toBe(404);
      expect(await c.snapshots.head()).toBe(head);
      f.grants.add(projectId);
      expect((await c.project.documents.revisions(id)).map((row) => row.number)).toEqual([1]);
      expect((await f.call(createPath, "POST", { ...command, title: "Changed replay" })).status).toBe(409);
      f.actor("operator:someone-else");
      expect((await f.call(createPath, "POST", command)).status).toBe(409);
      expect(await c.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "an interrupted first document commit recovers all file-tree members and its original creation receipt",
  async () => {
    const f = await projectFileApiFixture();
    f.grants.add(projectId);
    try {
      const command = create(),
        first = await f.call(createPath, "POST", command),
        c = await content(f),
        journal = new ProjectContentJournal(c.owned),
        original = await journal.receipt(command.id),
        head = await c.snapshots.head();
      expect(first.status).toBe(201);
      expect(original?.changes).toHaveLength(5);
      await withProjectGitLease(c.owned.directory, c.owned.coordination, async (lease) => {
        const receipts = join(c.owned.directory, ".git", "panda", "receipts");
        await unlink(join(receipts, command.id + ".json"));
        await syncContentDirectory(receipts);
        await c.snapshots.publish(original!.commit, original!.base);
        await journal.writePending(original!, lease.assertHeld);
      });
      f.reopen();
      expect((await f.call(createPath, "POST", command)).body).toEqual(first.body);
      expect(await journal.pending()).toBeNull();
      expect(await journal.receipt(command.id)).toEqual(original);
      expect(await c.snapshots.head()).toBe(head);
      expect(await c.snapshots.entries(head)).toHaveLength(5);
      expect((await f.call(source(first.body.operation.documentId))).status).toBe(200);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file navigation moves and renames preserve exact originals and retain a distinct unsaved working copy",
  async () => {
    const f = await projectFileApiFixture();
    f.grants.add(projectId);
    try {
      const initialBody = emptyRichBody();
      initialBody.document.content = [
        { type: "paragraph", content: [{ type: "text", text: "Saved formatted source", marks: [{ type: "bold" }] }] },
      ];
      const root = (await f.call(createPath, "POST", { ...create(), body: initialBody })).body.operation.documentId,
        child = (await f.call(createPath, "POST", create(1, "Child", root))).body.operation.documentId,
        other = (await f.call(createPath, "POST", create(2, "Other"))).body.operation.documentId,
        original = (await f.call(source(root))).body,
        working = (await f.call(editor(root))).body,
        body = emptyRichBody();
      body.document.content = [{ type: "paragraph", content: [{ type: "text", text: "Keep my unsaved work" }] }];
      working.working.body = body;
      expect(
        (
          await f.call(editor(root), "PUT", {
            operationId: "unsaved",
            version: 0,
            baseRevisionId: original.revision.id,
            working: working.working,
          })
        ).status,
      ).toBe(200);
      const move = action("move", 3, other, { target: { kind: "inside", documentId: child } }),
        moved = await f.call(actionsPath, "POST", move);
      expect(moved.status).toBe(200);
      expect(moved.body.tree.nodes.find((node: { documentId: string }) => node.documentId === other).parentId).toBe(
        child,
      );
      expect((await f.call(source(root))).body).toEqual(original);
      const renamed = await f.call(
        actionsPath,
        "POST",
        action("rename", 4, root, { title: "Renamed root", revision: 1 }),
      );
      expect(renamed.status).toBe(200);
      const current = (await f.call(source(root))).body,
        draft = (await f.call(editor(root))).body;
      expect(current.document).toMatchObject({
        path: original.document.path,
        revision: 2,
        title: "Renamed root",
        contentHash: original.document.contentHash,
      });
      expect(current.revision.body).toEqual(original.revision.body);
      expect(current.revision.content).toBe(original.revision.content);
      expect(current.revision.resources).toEqual(original.revision.resources);
      expect(draft.working.body).toEqual(body);
      expect(draft.draft).toMatchObject({ dirty: true, stale: true, version: 1 });
      const c = await content(f),
        head = await c.snapshots.head();
      expect((await c.project.documents.revision(root, original.revision.id)).title).toBe("Root");
      expect((await c.project.documents.revisions(root)).map((row) => row.number)).toEqual([2, 1]);
      const replay = await f.call(actionsPath, "POST", move);
      expect(replay.body.operation).toEqual(moved.body.operation);
      expect(replay.body.tree.version).toBe(5);
      expect(await c.snapshots.head()).toBe(head);
      const cycle = await f.call(
        actionsPath,
        "POST",
        action("move", 5, root, { target: { kind: "inside", documentId: other } }),
      );
      expect(cycle.status).toBe(400);
      expect(cycle.body.messageId).toBe("documents.invalidTreeMove");
      expect(await c.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file subtree trash, partial restoration and stable replays preserve source history and parent fallback",
  async () => {
    const f = await projectFileApiFixture();
    f.grants.add(projectId);
    try {
      const root = (await f.call(createPath, "POST", create())).body.operation.documentId,
        child = (await f.call(createPath, "POST", create(1, "Child", root))).body.operation.documentId,
        leaf = (await f.call(createPath, "POST", create(2, "Leaf", child))).body.operation.documentId,
        c = await content(f),
        rootBytes = await readFile(join(c.owned.directory, "documents", root + ".panda.json")),
        command = action("trash", 3, root, { revision: 1 }),
        removed = await f.call(actionsPath, "POST", command);
      expect(removed.status).toBe(200);
      expect(removed.body.tree.nodes).toEqual([]);
      expect(new Set(removed.body.operation.affectedDocumentIds)).toEqual(new Set([root, child, leaf]));
      expect((await f.call(trashPath)).body.documents).toMatchObject([{ document: { id: root }, subtreeCount: 3 }]);
      expect((await f.call(source(child))).status).toBe(404);
      const restored = await f.call(actionsPath, "POST", action("restore", 4, child));
      expect(restored.status).toBe(200);
      expect(restored.body.operation).toMatchObject({ restoredToRoot: true, affectedDocumentIds: [child, leaf] });
      expect(
        restored.body.tree.nodes.find((node: { documentId: string }) => node.documentId === child).parentId,
      ).toBeNull();
      expect(restored.body.tree.nodes.find((node: { documentId: string }) => node.documentId === leaf).parentId).toBe(
        child,
      );
      expect((await f.call(trashPath)).body.documents).toMatchObject([{ document: { id: root }, subtreeCount: 1 }]);
      expect((await f.call(actionsPath, "POST", action("restore", 5, root))).status).toBe(200);
      const head = await c.snapshots.head(),
        replay = await f.call(actionsPath, "POST", command);
      expect(replay.body.operation).toEqual(removed.body.operation);
      expect(replay.body.tree.nodes).toHaveLength(3);
      expect(replay.body.tree.version).toBe(6);
      expect(await c.snapshots.head()).toBe(head);
      expect(await readFile(join(c.owned.directory, "documents", root + ".panda.json"))).toEqual(rootBytes);
      expect(await c.project.documents.revisions(root)).toHaveLength(1);
      expect((await f.call(trashPath)).body.documents).toEqual([]);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "competing file-tree commands share project ownership and stale tree versions cannot add partial content",
  async () => {
    const f = await projectFileApiFixture();
    f.grants.add(projectId);
    try {
      const one = create(),
        two = create(0, "Competing root"),
        results = await Promise.all([f.call(createPath, "POST", one), f.call(createPath, "POST", two)]);
      expect(results.map((row) => row.status).sort()).toEqual([201, 409]);
      const tree = (await f.call(treePath)).body,
        c = await content(f),
        head = await c.snapshots.head();
      expect(tree.nodes).toHaveLength(1);
      expect((await c.snapshots.entries(head)).filter((row) => row.path.startsWith("documents/"))).toHaveLength(1);
      expect((await f.call(createPath, "POST", { ...create(1), parentId: "absent" })).status).toBe(404);
      expect(await c.snapshots.head()).toBe(head);
      await expect(
        c.project.coordinator.plan(
          { operationId: "late-plan-error", author: draftAuthor, message: "Test staged abort", intent: "late-error" },
          async (view) => {
            const plan = new ProjectContentPlan(view);
            plan.apply([{ path: "documents/never-created.panda.json", content: "A staged source" }]);
            plan.apply([{ path: "tree.json", content: "A staged tree" }]);
            throw Error("Late validation failed");
          },
        ),
      ).rejects.toThrow("Late validation failed");
      expect(await c.snapshots.head()).toBe(head);
      expect((await readdir(join(c.owned.directory, "documents"))).sort()).toEqual([
        tree.nodes[0].documentId + ".panda.json",
      ]);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file-tree HTTP honors authentication, origin, per-access grants and refuses repository adoption",
  async () => {
    const f = await projectFileApiFixture();
    f.grants.add(projectId);
    try {
      expect((await fetch(f.base + treePath)).status).toBe(401);
      expect((await f.call(createPath, "POST", create(), { origin: "https://untrusted.example" })).status).toBe(403);
      expect((await f.call(createPath, "POST", { ...create(), owner: "forged" })).status).toBe(400);
      f.grants.delete(projectId);
      expect((await f.call(createPath, "POST", create())).status).toBe(404);
      expect(await findOwnedProjectDirectory(f.root, projectId)).toBeNull();
      f.grants.add(projectId);
      const directory = join(f.root, "projects", projectId);
      await mkdir(directory);
      await writeFile(join(directory, "keep.txt"), "Existing project contents");
      expect((await f.call(treePath)).status).toBe(503);
      expect((await f.call(createPath, "POST", create())).status).toBe(503);
      expect(await readdir(directory)).toEqual(["keep.txt"]);
      expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("Existing project contents");
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "imported tree receipts remain replayable while incomplete legacy reservations stay explicit conflicts",
  async () => {
    const f = await projectFileApiFixture();
    try {
      await f.project.navigation.put(
        {
          spaceId: "space-1",
          version: 1,
          nodes: [{ documentId: "doc-1", parentId: null, position: 0 }],
          trash: [],
          origins: [],
          lastOperation: null,
        },
        null,
        "initial-tree",
        draftAuthor,
      );
      const id = randomUUID(),
        command = { id, projectId: "project-1", treeVersion: 1, documentId: "doc-1", target: { kind: "root" } },
        request = navigationRequest({
          kind: "move",
          id,
          projectId: "project-1",
          version: 1,
          documentId: "doc-1",
          target: { kind: "root" },
        }),
        original = {
          id,
          spaceId: "space-1",
          owner: "operator:test-user",
          request,
          documentId: "doc-1",
          createdAt: 100,
          result: null,
        };
      await f.project.navigationOperations.put(original, "import-reservation", draftAuthor);
      expect((await f.call(actionsPath, "POST", { action: "move", ...command })).status).toBe(409);
      const result = { id, documentId: "doc-1", affectedDocumentIds: ["doc-1"], treeVersion: 1, restoredToRoot: false };
      await f.project.navigationOperations.put({ ...original, result }, "import-completion", draftAuthor);
      const head = await f.snapshots.head(),
        replay = await f.call(actionsPath, "POST", { action: "move", ...command });
      expect(replay.status).toBe(200);
      expect(replay.body.operation).toEqual(result);
      expect(replay.body.tree.version).toBe(1);
      expect(await f.snapshots.head()).toBe(head);
    } finally {
      await f.close();
    }
  },
  30000,
);
