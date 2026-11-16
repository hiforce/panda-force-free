import { expect, test } from "bun:test";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { createContentAccess } from "../../src/server/content-access/integration/feature.js";
import { scopedFileDocuments } from "../../src/server/content-access/integration/files.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectKnowledgeMarkdown } from "../../src/server/project-content/paths.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectContentCoordinator } from "../../src/server/project-content/coordinator.js";

test("independent owner adapters queue reads of the same physical project instead of failing on ref-lock contention", async () => {
  const files = await projectFileApiFixture();
  try {
    const project = await files.application().projectContent.view("project-1", async (project) => project),
      outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () => new ProjectContentCoordinator(project.owned).read(["tree.json"])),
      );
    expect(outcomes.map((row) => row.status)).toEqual(Array(8).fill("fulfilled"));
  } finally {
    await files.close();
  }
}, 30000);

test("cached and previously opened file authorities cannot write after a project grant is revoked", async () => {
  const files = await projectFileApiFixture(),
    catalog = new ProjectCatalog(":memory:"),
    root = await mkdtemp(join(tmpdir(), "panda-scope-access-")),
    admin = "a".repeat(64),
    alice = "b".repeat(64);
  try {
    catalog.db.query("INSERT INTO projects VALUES('project-1','fixture-project','Fixture','',1,1)").run();
    const feature = createContentAccess(
        {
          db: catalog.db,
          stateRoot: root,
          projects: () => catalog.snapshot().projects,
          requireProject: (id) => catalog.project(id),
          documents: files.application().projectContent,
          owner: () => admin,
          localAdministrator: () => admin,
          ownerAllowed: () => true,
          report: () => {},
        },
        {},
      ),
      scoped = scopedFileDocuments({ root: files.root, assetRoot: files.assetRoot }, feature.require);
    await expect(feature.require(alice, "project-1")).rejects.toThrow();
    await feature.service.set(admin, { project: "project-1", owner: alice, role: "contributor", revision: 0 });
    const app = scoped(alice, "contribute"),
      repository = await app.projectContent.view("project-1", async (project) => project),
      before = await repository.coordinator.view(async (view) => view.commit);
    expect((await feature.service.view(alice)).projects.map((p) => p.id)).toEqual(["project-1"]);
    await feature.service.set(admin, { project: "project-1", owner: alice, role: "reader", revision: 1 });
    expect(scoped(alice, "contribute")).toBe(app);
    await expect(app.projectContent.view("project-1", async () => null)).rejects.toMatchObject({
      code: "notFound",
      status: 404,
    });
    let planned = false;
    await expect(
      repository.coordinator.plan(
        {
          operationId: randomUUID(),
          intent: "stale-permission",
          author: { name: "Fixture", email: "scope@example.test" },
          message: "Reject stale scope",
        },
        async () => {
          planned = true;
          return {
            changes: [
              { path: projectKnowledgeMarkdown("k-access-guard"), content: Buffer.from("Must never be saved") },
            ],
          };
        },
      ),
    ).rejects.toMatchObject({ code: "notFound", status: 404 });
    expect(planned).toBe(false);
    expect(await files.application().projectContent.view("project-1", async (_project, view) => view.commit)).toBe(
      before,
    );
    await expect(scoped(alice, "read").navigation.tree("project-1")).resolves.toHaveProperty("nodes");
    await feature.service.set(admin, { project: "project-1", owner: alice, role: null, revision: 2 });
    await expect(scoped(alice, "read").navigation.tree("project-1")).rejects.toMatchObject({
      code: "notFound",
      status: 404,
    });
    await expect(feature.service.grants(alice, "project-1")).rejects.toThrow("forbidden");
  } finally {
    catalog.close();
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("an asynchronous authorization check prevents publishing a plan after its permission is revoked", async () => {
  const files = await projectFileApiFixture();
  try {
    const project = await files.application().projectContent.view("project-1", async (p) => p),
      before = await project.coordinator.view(async (view) => view.commit);
    let allowed = true,
      planned = false;
    const scoped = new ProjectContentCoordinator(project.owned, async () => {
      await Promise.resolve();
      if (!allowed) throw Error("Permission revoked");
    });
    await expect(
      scoped.plan(
        {
          operationId: randomUUID(),
          intent: "revocation-during-planning",
          author: { name: "Author", email: "author@example.test" },
          message: "Must not publish",
        },
        async () => {
          planned = true;
          allowed = false;
          return {
            changes: [{ path: projectKnowledgeMarkdown("k-revoked"), content: Buffer.from("Private material") }],
          };
        },
      ),
    ).rejects.toThrow("Permission revoked");
    expect(planned).toBe(true);
    expect(await project.coordinator.view(async (view) => view.commit)).toBe(before);
    await expect(scoped.read(["tree.json"])).rejects.toThrow("Permission revoked");
  } finally {
    await files.close();
  }
}, 30000);
