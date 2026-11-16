import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { MySQLProjectCatalog } from "../../src/server/projects/mysql-catalog.js";
import { ProjectWorkspaceService } from "../../src/server/projects/workspaces/service.js";
import { ContentAccessStore } from "../../src/server/content-access/storage/grants.js";
import { MySQLContentAccessStore } from "../../src/server/content-access/storage/mysql.js";
import { createContentAccess } from "../../src/server/content-access/integration/feature.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { mysqlDataMigrationModule } from "../../src/server/database/modules/migrations.js";
import { mysqlProjectsModule } from "../../src/server/database/modules/projects.js";
import { mysqlContentAccessModule } from "../../src/server/database/modules/content-access.js";
import { migrateProjectsSnapshot } from "../../src/server/projects/migrate.js";
import { migrateContentAccessSnapshot } from "../../src/server/content-access/storage/migrate.js";

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "MySQL memberships migrate without granting access; creator grants share project rollback and revocations are awaited",
  async () => {
    const f = await isolatedMySQLDatabase("access"),
      root = await mkdtemp(join(tmpdir(), "content-access-mysql-")),
      sourcePath = join(root, "source.sqlite"),
      source = new ProjectCatalog(sourcePath),
      admin = "a".repeat(64),
      alice = "b".repeat(64),
      bob = "c".repeat(64);
    try {
      const p = source.save({ code: "existing-project", name: "Existing" }, 0).projects[0]!,
        old = new ContentAccessStore(source.db);
      old.set(admin, p.id, alice, "reader", 0, 1000);
      const snapshotPath = join(root, "snapshot.sqlite"),
        reader = new Database(sourcePath, { readonly: true });
      try {
        reader.query("VACUUM INTO ?").run(snapshotPath);
      } finally {
        reader.close();
      }
      const registry = new DatabaseRegistry()
        .register(mysqlDataMigrationModule)
        .register(mysqlProjectsModule)
        .register(mysqlContentAccessModule);
      await registry.upgrade(new MySQLSchemaConnection(f.sql));
      await migrateProjectsSnapshot({ sql: f.sql, snapshotPath, migrationId: "projects-v1" });
      await migrateContentAccessSnapshot({ sql: f.sql, snapshotPath, migrationId: "access-v1" });
      const catalog = new MySQLProjectCatalog(f.sql),
        store = new MySQLContentAccessStore(catalog),
        feature = createContentAccess(
          {
            store,
            stateRoot: root,
            projects: async () => (await catalog.snapshot()).projects,
            requireProject: (id) => catalog.project(id),
            documents: new DocumentFileProjects(join(root, "content"), (id) => catalog.project(id)),
            localAdministrator: () => admin,
            ownerAllowed: () => true,
            owner: () => alice,
            report: () => {},
          },
          {},
        );
      expect(await store.grants(p.id)).toEqual(old.grants(p.id));
      await expect(feature.require(alice, p.id)).resolves.toBeUndefined();
      await expect(feature.require(alice, p.id, "contribute")).rejects.toMatchObject({ code: "notFound" });
      await expect(feature.require(bob, p.id)).rejects.toMatchObject({ code: "notFound" });
      expect((await feature.service.view(alice)).projects).toEqual([{ id: p.id, name: p.name, role: "reader" }]);
      await store.set(admin, p.id, alice, "blocked", 1, 1001);
      await expect(feature.require(alice, p.id)).rejects.toMatchObject({ code: "notFound" });
      expect((await feature.service.view(alice)).projects).toEqual([]);
      const simultaneous = await Promise.allSettled([
        store.set(admin, p.id, alice, "contributor", 2, 1002),
        new MySQLContentAccessStore(new MySQLProjectCatalog(f.sql)).set(admin, p.id, bob, "reader", 2, 1002),
      ]);
      expect(simultaneous.filter((v) => v.status === "fulfilled")).toHaveLength(1);
      expect(simultaneous.filter((v) => v.status === "rejected")).toHaveLength(1);
      const current = await catalog.snapshot(),
        before = await store.revision();
      let failedProject = "";
      const fail = new ProjectWorkspaceService(catalog, join(root, "workspaces"), true, async (project, owner) => {
        failedProject = project.id;
        await catalog.bindFiles(project.id);
        await feature.reserveCreatorAsync(owner!, project.id);
        throw Error("Injected metadata rollback");
      });
      await expect(
        fail.create({ name: "Rollback", code: "rollback-project" }, current.revision, "rollback", alice),
      ).rejects.toMatchObject({ status: 503 });
      expect(await catalog.snapshot()).toEqual(current);
      expect(await store.revision()).toBe(before);
      expect(await store.role(alice, failedProject)).toBeNull();
      const create = new ProjectWorkspaceService(catalog, join(root, "workspaces"), true, async (project, owner) => {
        await catalog.bindFiles(project.id);
        await feature.reserveCreatorAsync(owner!, project.id);
      });
      const created = await create.create({ name: "Owned", code: "owned-project" }, current.revision, "owned", alice),
        owned = created.projects.find((p) => p.code === "owned-project")!;
      await expect(feature.require(alice, owned.id, "contribute")).resolves.toBeUndefined();
      await expect(feature.require(bob, owned.id)).rejects.toMatchObject({ code: "notFound" });
      await expect(feature.reserveCreatorAsync(bob, owned.id)).rejects.toMatchObject({ code: "invalidInput" });
      expect(await registry.inspect(new MySQLSchemaConnection(f.sql))).toEqual([]);
    } finally {
      source.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
