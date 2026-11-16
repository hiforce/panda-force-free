import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";
import { ProjectWorkspaceService } from "../../src/server/projects/workspaces/service.js";
import { ProjectWorkspaceDirectory } from "../../src/server/projects/workspaces/directory.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-project-reservation-")),
    path = join(root, "catalog.sqlite"),
    catalog = new ProjectCatalog(path),
    storage = new ProjectDocumentStorage(catalog.db);
  return {
    root,
    path,
    catalog,
    storage,
    close: async () => {
      catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const fields = { code: "file-project", name: "File project" };

test("document binding shares project reservation and a failed reservation rolls back every row", async () => {
  const f = await fixture();
  try {
    const service = new ProjectWorkspaceService(f.catalog, join(f.root, "projects"), true, (project) => {
      expect(f.catalog.db.inTransaction).toBe(true);
      f.storage.bindFiles(project.id);
      expect(f.storage.files(project.id)).toBe(true);
      throw Error("Reservation failed");
    });
    await expect(service.create(fields, 0, "failed-create")).rejects.toMatchObject({
      status: 503,
      messageId: "projects.errorWorkspaceUnavailable",
    });
    expect(f.catalog.snapshot().projects).toEqual([]);
    expect(f.catalog.revision()).toBe(0);
    for (const table of ["project_document_storage", "project_workspaces", "project_workspace_creations"])
      expect(f.catalog.db.query<{ count: number }, []>("SELECT count(*) AS count FROM " + table).get()!.count).toBe(0);
    await expect(stat(join(f.root, "projects", fields.code))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("a prepared metadata reservation survives a filesystem failure and retries after restart without rebinding", async () => {
  const f = await fixture();
  let reservations = 0;
  const preparation = spyOn(ProjectWorkspaceDirectory.prototype, "prepare").mockRejectedValueOnce(
    Error("Disk unavailable"),
  );
  try {
    const service = new ProjectWorkspaceService(f.catalog, join(f.root, "projects"), true, (project) => {
      reservations++;
      f.storage.bindFiles(project.id);
    });
    await expect(service.create(fields, 0, "resumable-create")).rejects.toThrow();
    preparation.mockRestore();
    const project = f.catalog.snapshot().projects[0]!;
    expect(project.workspace!.state).toBe("preparing");
    expect(f.storage.files(project.id)).toBe(true);
    const reopened = new ProjectCatalog(f.path),
      storage = new ProjectDocumentStorage(reopened.db);
    try {
      const retried = await new ProjectWorkspaceService(reopened, join(f.root, "projects"), true, (current) => {
        reservations++;
        storage.bindFiles(current.id);
      }).create(fields, 0, "resumable-create");
      expect(retried.projects).toHaveLength(1);
      expect(retried.projects[0]!.id).toBe(project.id);
      expect(retried.projects[0]!.workspace!.state).toBe("ready");
      expect(storage.files(project.id)).toBe(true);
      expect(reservations).toBe(1);
    } finally {
      reopened.close();
    }
  } finally {
    preparation.mockRestore();
    await f.close();
  }
});

test("upgrading project defaults never rebinds a historical creation receipt or an ensured workspace", async () => {
  const f = await fixture();
  try {
    const legacy = new ProjectWorkspaceService(f.catalog, join(f.root, "projects")),
      project = (await legacy.create(fields, 0, "legacy-create")).projects[0]!;
    let reservations = 0;
    const upgraded = new ProjectWorkspaceService(f.catalog, join(f.root, "projects"), true, (current) => {
      reservations++;
      f.storage.bindFiles(current.id);
    });
    await upgraded.ensure(project.id);
    const retried = await upgraded.create(fields, 0, "legacy-create");
    expect(retried.projects[0]!.id).toBe(project.id);
    expect(f.storage.files(project.id)).toBe(false);
    expect(reservations).toBe(0);
    const next = await upgraded.create({ ...fields, code: "new-file-project" }, retried.revision, "new-create");
    expect(f.storage.files(next.projects.find((item) => item.code === "new-file-project")!.id)).toBe(true);
    expect(reservations).toBe(1);
  } finally {
    await f.close();
  }
});
