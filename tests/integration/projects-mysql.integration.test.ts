import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlProjectsModule } from "../../src/server/database/modules/projects.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";
import { MySQLProjectCatalog } from "../../src/server/projects/mysql-catalog.js";
import { migrateProjectsSnapshot } from "../../src/server/projects/migrate.js";
import { ProjectWorkspaceService } from "../../src/server/projects/workspaces/service.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "project migration preserves workspace ownership and session assignments; MySQL reservations roll back and resume",
  async () => {
    const f = await isolatedMySQLDatabase("projects"),
      root = await mkdtemp(join(tmpdir(), "projects-mysql-")),
      sourcePath = join(root, "projects.sqlite"),
      source = new ProjectCatalog(sourcePath),
      storage = new ProjectDocumentStorage(source.db),
      workspaceRoot = join(root, "workspaces"),
      legacy = new ProjectWorkspaceService(source, workspaceRoot, true, (p) => {
        storage.bindFiles(p.id);
      });
    try {
      const original = await legacy.create(
          { name: "Project", code: "project-code", description: "Existing files" },
          0,
          "create-original",
        ),
        project = original.projects[0]!;
      source.assign(
        project.id,
        [{ id: "engine-session", name: "Preserved session", cwd: project.workspace!.path, updatedAt: 1234 }],
        original.revision,
      );
      await writeFile(join(project.workspace!.path, "user-content.txt"), "Unchanged project file");
      const before = source.snapshot(),
        snapshotPath = join(root, "snapshot.sqlite"),
        reader = new Database(sourcePath, { readonly: true });
      try {
        reader.query("VACUUM INTO ?").run(snapshotPath);
      } finally {
        reader.close();
      }
      const registry = new DatabaseRegistry().register(mysqlDataMigrationModule).register(mysqlProjectsModule);
      await registry.upgrade(new MySQLSchemaConnection(f.sql));
      await migrateProjectsSnapshot({ sql: f.sql, snapshotPath, migrationId: "projects-v1" });
      const first = new MySQLProjectCatalog(f.sql),
        second = new MySQLProjectCatalog(f.sql),
        service = new ProjectWorkspaceService(first, workspaceRoot, true, async (p) => {
          await first.bindFiles(p.id);
        });
      expect(await first.snapshot()).toEqual(before);
      expect(await first.files(project.id)).toBe(true);
      expect(
        await service.create(
          { name: "Project", code: "project-code", description: "Existing files" },
          0,
          "create-original",
        ),
      ).toEqual(before);
      expect(await readFile(join(project.workspace!.path, "user-content.txt"), "utf8")).toBe("Unchanged project file");
      await expect(
        first.save({ id: project.id, name: "Project", code: "changed-code" }, before.revision),
      ).rejects.toMatchObject({ status: 409 });
      const competing = await Promise.allSettled([
        first.save({ name: "Revision A", code: "revision-a" }, before.revision),
        second.save({ name: "Revision B", code: "revision-b" }, before.revision),
      ]);
      expect(competing.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(competing.filter((x) => x.status === "rejected")).toHaveLength(1);
      const current = await first.snapshot();
      const failing = new ProjectWorkspaceService(first, workspaceRoot, true, async (p) => {
        await first.bindFiles(p.id);
        throw Error("Injected reservation failure");
      });
      await expect(
        failing.create({ name: "Rollback", code: "rollback-project" }, current.revision, "rollback-operation"),
      ).rejects.toMatchObject({ status: 503 });
      expect(await first.snapshot()).toEqual(current);
      expect(await first.workspaceMetadata.operation("rollback-operation")).toBeNull();
      expect(Number((await f.sql`SELECT COUNT(*) n FROM panda_force_project_document_storage`)[0].n)).toBe(1);
      const created = await service.create(
        { name: "New project", code: "new-project" },
        current.revision,
        "new-operation",
      );
      const added = created.projects.find((p) => p.code === "new-project")!;
      expect(await first.files(added.id)).toBe(true);
      const marker = await readFile(join(added.workspace!.path, ".panda-workspace.json"), "utf8");
      expect((await new ProjectWorkspaceService(second, workspaceRoot).ensure(added.id)).state).toBe("ready");
      expect(await readFile(join(added.workspace!.path, ".panda-workspace.json"), "utf8")).toBe(marker);
      const refreshed = await second.refreshSessions([{ id: "engine-session", name: "Renamed session" }]);
      expect(refreshed?.assignments[0]!.updatedAt).toBe(1234);
      expect(refreshed?.assignments[0]!.name).toBe("Renamed session");
      await first.forgetSession("engine-session");
      expect((await second.snapshot()).assignments).toEqual([]);
      expect(await registry.inspect(new MySQLSchemaConnection(f.sql))).toEqual([]);
    } finally {
      source.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
