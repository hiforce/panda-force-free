import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  applicationDatabaseModules,
  createApplicationDatabaseRegistry,
} from "../../src/server/database/application-registry.js";
import { databaseConfiguration } from "../../src/server/database/config.js";
import { DatabaseManagementState } from "../../src/server/database/management/state.js";
import {
  activateApplicationDatabase,
  claimApplicationDatabase,
  databaseTargetHash,
} from "../../src/server/database/migration/activation.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { applicationMySQLRuntimeBindings } from "../../src/server/database/runtime-stores.js";
import { createAppFixture } from "../support/app-fixture.mjs";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

const guarded = test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE);
async function sqliteFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await sqliteFiles(path)));
    else if (entry.name.endsWith(".sqlite")) result.push(path);
  }
  return result;
}

test("default main keeps SQLite project reservations and browser metadata responses usable", async () => {
  const app = await createAppFixture();
  try {
    const initial = await fetch(app.base + "/api/projects", { headers: app.headers });
    expect(initial.status).toBe(200);
    const snapshot = await initial.json();
    expect(Array.isArray(snapshot.projects)).toBe(true);
    const response = await fetch(app.base + "/api/projects", {
      method: "POST",
      headers: { ...app.headers, "content-type": "application/json" },
      body: JSON.stringify({
        code: "runtime-default",
        name: "Runtime default",
        revision: snapshot.revision,
        operationId: randomUUID(),
      }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()).projects[0].code).toBe("runtime-default");
    expect((await sqliteFiles(join(app.dir, "panda-state"))).some((path) => path.endsWith("projects.sqlite"))).toBe(
      true,
    );
  } finally {
    await app.dispose();
  }
}, 120000);

guarded(
  "activated native main uses the complete trusted bindings and creates no business SQLite ledger",
  async () => {
    const database = await isolatedMySQLDatabase("runtime");
    let app: Awaited<ReturnType<typeof createAppFixture>> | undefined;
    try {
      expect([...applicationMySQLRuntimeBindings].sort()).toEqual([...applicationDatabaseModules].sort());
      const registry = createApplicationDatabaseRegistry(),
        schema = new MySQLSchemaConnection(database.sql);
      registry.assertCutoverReady("mysql", "sqlite");
      await registry.upgrade(schema);
      expect(await registry.inspect(schema)).toEqual([]);
      const input = await Bun.file(process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE!).json(),
        target = String((await database.sql.unsafe("SELECT DATABASE() selected"))[0].selected),
        config = databaseConfiguration({
          schema: 1,
          driver: "mysql",
          mysql: {
            hostname: input.hostname,
            port: input.port,
            database: target,
            username: input.username,
            password: input.password,
            tls: {
              mode: "verify",
              caFile: join(dirname(process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE!), "mysql-tls", "server-cert.pem"),
            },
            max: 8,
            connectionTimeout: 5,
            idleTimeout: 5,
          },
        });
      if (config.driver !== "mysql") throw Error("Expected native fixture configuration");
      app = await createAppFixture({
        startupTimeoutMs: 120000,
        prepareState: async ({ stateRoot }) => {
          const state = new DatabaseManagementState(stateRoot),
            installation = await state.installation(false),
            activation = {
              schema: 1 as const,
              installationId: installation.id,
              operationId: randomUUID(),
              targetHash: databaseTargetHash(config),
            };
          await claimApplicationDatabase(database.sql, activation);
          await activateApplicationDatabase({ sql: database.sql, state, activation, config });
        },
      });
      const call = async (path: string, body?: unknown) => {
        const response = await fetch(app!.base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { ...app!.headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, value: await response.json() };
      };
      expect((await call("/api/auth/setup", { username: "runtime-owner" })).status).toBe(200);
      const before = await call("/api/projects");
      expect(before.status).toBe(200);
      const created = await call("/api/projects", {
        code: "runtime-native",
        name: "Runtime native",
        revision: before.value.revision,
        operationId: randomUUID(),
      });
      expect(created.status).toBe(201);
      expect(created.value.projects[0].workspace.state).toBe("ready");
      const stored = await database.sql.unsafe(
        "SELECT p.id,w.state,d.storage,g.role FROM panda_force_projects p JOIN panda_force_project_workspaces w ON w.projectId=p.id JOIN panda_force_project_document_storage d ON d.project_id=p.id JOIN panda_force_content_access_grants g ON g.project=p.id WHERE p.code='runtime-native'",
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ state: "ready", storage: "files", role: "contributor" });
      expect(
        await database.sql.unsafe("SELECT id FROM panda_force_identity_credentials WHERE id='administrator'"),
      ).toHaveLength(1);
      expect((await call("/api/projects")).value.projects[0].id).toBe(stored[0].id);
      const files = await sqliteFiles(join(app.dir, "panda-state"));
      expect(files.map((path) => relative(join(app!.dir, "panda-state"), path))).toEqual([]);
      await app.stop();
      await app.start();
      expect((await call("/api/projects")).value.projects[0].id).toBe(stored[0].id);
    } finally {
      await app?.dispose();
      await database.close();
    }
  },
  600000,
);
