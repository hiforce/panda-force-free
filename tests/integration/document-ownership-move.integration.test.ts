import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { resolve } from "node:path";
import { FileDocumentOwnershipSource } from "../../src/server/documents/ownership/file-source.js";
import { FileDocumentOwnershipRemoval } from "../../src/server/documents/ownership/file-source-removal.js";
import { FileDocumentOwnershipTarget } from "../../src/server/documents/ownership/file-target.js";
import { FileDocumentOwnershipMove } from "../../src/server/documents/ownership/file-move.js";
import { fileOwnershipInventory, freezeOwnershipPlan } from "../../src/server/documents/ownership/plan.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

type Fixture = Awaited<ReturnType<typeof projectFileApiFixture>>;
async function revise(f: Fixture, project: string, id: string, text: string, title = "Original title") {
  const app = f.application(),
    opened = await app.queries.editor(project, id);
  await app.editor.autosave("owner", project, id, {
    operationId: randomUUID(),
    version: opened.draft.version,
    baseRevisionId: opened.saved.revision.id,
    working: { title, locale: "en", content: "", resources: [], body: richDocumentFromMarkdown(text) },
  });
  const draft = await app.queries.editor(project, id);
  await app.editor.save("owner", project, id, {
    operationId: randomUUID(),
    draftVersion: draft.draft.version,
    revisionId: draft.saved.revision.id,
  });
}
function services(f: Fixture, afterStep?: (step: "staged" | "removed" | "activated") => Promise<void>) {
  const source = new FileDocumentOwnershipSource(f.application().projectContent, f.assetRoot),
    removal = new FileDocumentOwnershipRemoval(f.application().projectContent),
    target = new FileDocumentOwnershipTarget(f.application().projectContent, f.assetRoot);
  const move = new FileDocumentOwnershipMove(
    source,
    removal,
    target,
    async (_owner, scope) => f.application().projectContent.authorize(scope.projectId),
    afterStep,
  );
  return { source, removal, target, move };
}
test("ownership movement and a return move preserve the same subtree, every version and original image; old receipts cannot roll back later work", async () => {
  const f = await projectFileApiFixture();
  f.grants.add("project-2");
  try {
    const app = f.application(),
      root = await app.navigation.create("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        title: "Original title",
        locale: "en",
      }),
      id = root.operation.documentId,
      child = await app.navigation.create("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: root.tree.version,
        parentId: id,
        title: "Child",
        locale: "en",
      }),
      bytes = await sharp({ create: { width: 3, height: 4, channels: 3, background: "#408080" } })
        .png()
        .toBuffer(),
      imageId = randomUUID();
    await app.assets.upload("owner", "project-1", id, "Original image.png", imageId, bytes);
    await revise(f, "project-1", id, "Second historical body");
    await revise(f, "project-1", id, "Third complete body");
    const s = services(f),
      snapshot = await s.source.capture("project-1", id),
      inventory = fileOwnershipInventory(snapshot),
      plan = freezeOwnershipPlan(
        "owner",
        randomUUID(),
        { projectId: "project-1" },
        { projectId: "project-2" },
        null,
        inventory,
      ),
      originalVersions = await Promise.all(
        snapshot.versions.map((row) => s.source.version(snapshot, row.revision.documentId, row.revision.id)),
      ),
      receipt = await s.move.execute(plan, snapshot);
    expect(receipt).toMatchObject({ documentId: id, projectId: "project-2", revision: 3 });
    expect((await app.navigation.tree("project-1")).nodes).toHaveLength(0);
    expect((await app.navigation.trashPage("project-1")).documents).toHaveLength(0);
    await expect(app.queries.detail("project-1", id)).rejects.toMatchObject({ code: "notFound" });
    await expect(app.assets.content("project-1", imageId)).rejects.toMatchObject({ code: "notFound" });
    const targetTree = await app.navigation.tree("project-2");
    expect(targetTree.nodes.map((row) => row.documentId).sort()).toEqual([id, child.operation.documentId].sort());
    expect(targetTree.nodes.find((row) => row.documentId === child.operation.documentId)!.parentId).toBe(id);
    expect((await app.assets.content("project-2", imageId)).bytes).toEqual(bytes);
    for (const original of originalVersions)
      expect(await app.queries.revision("project-2", original.document.id, original.revision.id)).toEqual(
        original.revision,
      );
    await revise(f, "project-2", id, "Later work after moving", "Later title");
    f.reopen();
    const restarted = services(f);
    expect(await restarted.move.execute(plan, snapshot)).toEqual(receipt);
    expect((await f.application().queries.detail("project-2", id)).revision.content).toContain("Later work");
    const backSnapshot = await restarted.source.capture("project-2", id),
      back = freezeOwnershipPlan(
        "owner",
        randomUUID(),
        { projectId: "project-2" },
        { projectId: "project-1" },
        null,
        fileOwnershipInventory(backSnapshot),
      );
    const returned = await restarted.move.execute(back, backSnapshot);
    expect(returned).toMatchObject({ documentId: id, projectId: "project-1", revision: 4 });
    expect((await f.application().navigation.tree("project-2")).nodes).toHaveLength(0);
    expect((await f.application().queries.detail("project-1", id)).revision.title).toBe("Later title");
    expect(await f.application().queries.revisions("project-1", id)).toHaveLength(4);
    expect((await f.application().assets.content("project-1", imageId)).bytes).toEqual(bytes);
    expect(await restarted.move.execute(plan, snapshot)).toEqual(receipt);
    expect((await f.application().navigation.tree("project-2")).nodes).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 60000);

for (const step of ["staged", "removed", "activated"] as const)
  test(`ownership movement resumes its actual durable phase after ${step} without an active duplicate`, async () => {
    const f = await projectFileApiFixture();
    f.grants.add("project-2");
    try {
      const created = await f.application().navigation.create("owner", {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: 0,
          parentId: null,
          title: "Resume source",
          locale: "en",
        }),
        id = created.operation.documentId,
        s = services(f),
        snapshot = await s.source.capture("project-1", id),
        inventory = fileOwnershipInventory(snapshot),
        plan = freezeOwnershipPlan(
          "owner",
          randomUUID(),
          { projectId: "project-1" },
          { projectId: "project-2" },
          null,
          inventory,
        );
      const proof = JSON.stringify({
          root: resolve(f.owned.directory, "../.."),
          assetRoot: f.assetRoot,
          plan,
          snapshot,
          step,
        }),
        child = Bun.spawn(
          [
            process.execPath,
            "--eval",
            `
          import {DocumentFileProjects} from './src/server/documents/files/projects.ts';
          import {FileDocumentOwnershipSource} from './src/server/documents/ownership/file-source.ts';
          import {FileDocumentOwnershipRemoval} from './src/server/documents/ownership/file-source-removal.ts';
          import {FileDocumentOwnershipTarget} from './src/server/documents/ownership/file-target.ts';
          import {FileDocumentOwnershipMove} from './src/server/documents/ownership/file-move.ts';
          const value=JSON.parse(process.env.PANDA_FORCE_MOVE_PROOF);
          const authorize=async(id)=>{if(!['project-1','project-2'].includes(id))throw Error('Denied');};
          const projects=new DocumentFileProjects(value.root,authorize);
          const source=new FileDocumentOwnershipSource(projects,value.assetRoot),removal=new FileDocumentOwnershipRemoval(projects),target=new FileDocumentOwnershipTarget(projects,value.assetRoot);
          await new FileDocumentOwnershipMove(source,removal,target,async(_owner,scope)=>authorize(scope.projectId),async step=>{if(step===value.step)process.exit(73);}).execute(value.plan,value.snapshot);
        `,
          ],
          {
            cwd: new URL("../..", import.meta.url).pathname,
            env: { ...process.env, PANDA_FORCE_MOVE_PROOF: proof, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
      const errors = await new Response(child.stderr).text();
      expect({ exit: await child.exited, errors }).toEqual({ exit: 73, errors: "" });
      const counts = [
        (await f.application().navigation.tree("project-1")).nodes.length,
        (await f.application().navigation.tree("project-2")).nodes.length,
      ];
      expect(counts[0]! + counts[1]!).toBeLessThanOrEqual(1);
      if (step === "staged") {
        expect(counts).toEqual([1, 0]);
        expect((await f.application().navigation.trashPage("project-2")).documents).toHaveLength(0);
      }
      if (step === "removed") expect(counts).toEqual([0, 0]);
      f.reopen();
      const fresh = services(f),
        receipt = await fresh.move.execute(plan, JSON.parse(JSON.stringify(snapshot)));
      expect(receipt.documentId).toBe(id);
      expect((await f.application().navigation.tree("project-1")).nodes).toHaveLength(0);
      expect((await f.application().navigation.tree("project-2")).nodes).toHaveLength(1);
      expect(await f.application().queries.revisions("project-2", id)).toHaveLength(1);
      expect(await fresh.move.execute(plan, snapshot)).toEqual(receipt);
    } finally {
      await f.close();
    }
  }, 60000);

test("a source edit during staging remains active; a fresh frozen plan safely completes while the old plan cannot retake the target", async () => {
  const f = await projectFileApiFixture();
  f.grants.add("project-2");
  try {
    const created = await f.application().navigation.create("owner", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        title: "Original title",
        locale: "en",
      }),
      id = created.operation.documentId,
      s = services(f, async (step) => {
        if (step === "staged") await revise(f, "project-1", id, "New manual correction");
      }),
      snapshot = await s.source.capture("project-1", id),
      plan = freezeOwnershipPlan(
        "owner",
        randomUUID(),
        { projectId: "project-1" },
        { projectId: "project-2" },
        null,
        fileOwnershipInventory(snapshot),
      );
    await expect(s.move.execute(plan, snapshot)).rejects.toMatchObject({ code: "conflict" });
    expect((await f.application().navigation.tree("project-1")).nodes).toHaveLength(1);
    expect((await f.application().navigation.tree("project-2")).nodes).toHaveLength(0);
    const next = services(f),
      latest = await next.source.capture("project-1", id),
      newPlan = freezeOwnershipPlan("owner", randomUUID(), plan.from, plan.to, null, fileOwnershipInventory(latest));
    const saved = await next.move.execute(newPlan, latest);
    expect(saved).toMatchObject({ documentId: id, revision: 2 });
    expect((await f.application().queries.detail("project-2", id)).revision.content).toContain("New manual correction");
    await expect(next.move.execute(plan, snapshot)).rejects.toMatchObject({ code: "notFound" });
    expect((await f.application().queries.detail("project-2", id)).document.revision).toBe(2);
  } finally {
    await f.close();
  }
}, 60000);

for (const phase of ["staged", "removed"] as const)
  test(`revoked target permission at ${phase} cannot expose or activate content; recovery uses the same identity`, async () => {
    const f = await projectFileApiFixture();
    f.grants.add("project-2");
    try {
      const created = await f.application().navigation.create("owner", {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: 0,
          parentId: null,
          title: "Permission checked source",
          locale: "en",
        }),
        id = created.operation.documentId,
        s = services(f, async (step) => {
          if (step === phase) f.grants.delete("project-2");
        }),
        snapshot = await s.source.capture("project-1", id),
        plan = freezeOwnershipPlan(
          "owner",
          randomUUID(),
          { projectId: "project-1" },
          { projectId: "project-2" },
          null,
          fileOwnershipInventory(snapshot),
        );
      await expect(s.move.execute(plan, snapshot)).rejects.toMatchObject({ code: "notFound" });
      expect((await f.application().navigation.tree("project-1")).nodes).toHaveLength(phase === "staged" ? 1 : 0);
      f.grants.add("project-2");
      expect((await f.application().navigation.tree("project-2")).nodes).toHaveLength(0);
      const recovered = await services(f).move.execute(plan, snapshot);
      expect(recovered.documentId).toBe(id);
      expect((await f.application().navigation.tree("project-1")).nodes).toHaveLength(0);
      expect((await f.application().navigation.tree("project-2")).nodes).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 60000);

test("a personal ownership scope cannot select another principal's namespace", async () => {
  const f = await projectFileApiFixture();
  f.grants.add("personal");
  f.grants.add("project-2");
  try {
    const created = await f
        .application()
        .navigation.create("owner", {
          id: randomUUID(),
          projectId: "personal",
          treeVersion: 0,
          parentId: null,
          title: "Private original",
          locale: "en",
        }),
      id = created.operation.documentId,
      s = services(f),
      snapshot = await s.source.capture("personal", id),
      plan = freezeOwnershipPlan(
        "owner",
        randomUUID(),
        { projectId: "personal", personalOwnerHash: "b".repeat(64) },
        { projectId: "project-2" },
        null,
        fileOwnershipInventory(snapshot),
      );
    await expect(s.move.execute(plan, snapshot)).rejects.toMatchObject({ code: "notFound" });
    expect((await f.application().navigation.tree("personal")).nodes).toHaveLength(1);
    expect((await f.application().navigation.tree("project-2")).nodes).toHaveLength(0);
  } finally {
    await f.close();
  }
});
