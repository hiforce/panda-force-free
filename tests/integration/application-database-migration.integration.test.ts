import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DatabaseOperation } from "../../src/shared/database/contracts.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";

const guarded = test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE);
async function liveSQLiteFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "database-management") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await liveSQLiteFiles(path)));
    else if (entry.name.endsWith(".sqlite")) result.push(path);
  }
  return result.sort();
}

guarded(
  "normal managed restart migrates SQLite application state through maintenance into durable native MySQL",
  async () => {
    const database = await isolatedMySQLDatabase("migration");
    let app: Awaited<ReturnType<typeof createAppFixture>> | undefined;
    try {
      const input = await Bun.file(process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE!).json(),
        target = String((await database.sql.unsafe("SELECT DATABASE() selected"))[0].selected);
      const connection = {
        hostname: input.hostname,
        port: input.port ?? 3306,
        database: target,
        username: input.username,
        password: input.password,
        tls: {
          mode: "verify" as const,
          caFile: join(dirname(process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE!), "mysql-tls", "server-cert.pem"),
        },
        max: 8,
        connectionTimeout: 5,
        idleTimeout: 5,
      };
      app = await createAppFixture({
        startupTimeoutMs: 900000,
        extraEnvironment: () => ({ PANDA_FORCE_MANAGED_RESTART: "1" }),
      });
      const call = async (path: string, body?: unknown) => {
        const response = await fetch(app!.base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { ...app!.headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, value: await response.json() };
      };
      expect((await call("/api/auth/setup", { username: "migration-owner" })).status).toBe(200);
      expect((await call("/api/system/database/selection", { driver: "sqlite" })).status).toBe(200);
      const before = await call("/api/projects"),
        created = await call("/api/projects", {
          code: "migration-fixture",
          name: "Migration fixture",
          revision: before.value.revision,
          operationId: randomUUID(),
        });
      expect(created.status).toBe(201);
      const projectId = created.value.projects[0].id;
      const skills = await call("/api/skill-packs?limit=10");
      expect(skills.status).toBe(200);
      const skillRecords = skills.value.packages.map(
        (pack: { id: string; version: string; digest: string; active: boolean }) => ({
          id: pack.id,
          version: pack.version,
          digest: pack.digest,
          active: pack.active,
        }),
      );
      expect(skillRecords.length).toBeGreaterThan(0);
      const stateRoot = join(app.dir, "panda-state"),
        original = await liveSQLiteFiles(stateRoot);
      expect(original.some((path) => path.endsWith("projects.sqlite"))).toBe(true);
      const plan = await call("/api/system/database/plan", connection);
      expect(plan.status).toBe(200);
      if (!plan.value.ready) throw Error("Migration plan rejected: " + JSON.stringify(plan.value.issues));
      const requestId = randomUUID(),
        statusToken = randomBytes(32).toString("base64url"),
        operationPath = "/api/system/database/operations/" + requestId;
      await writeFile(
        join(app.dir, "database-client.private.json"),
        JSON.stringify({ requestId, statusToken, original, projectId, skillRecords }),
        { mode: 0o600 },
      );
      const submitted = await call("/api/system/database/migrate", { planId: plan.value.id, requestId, statusToken });
      expect(submitted.status).toBe(202);
      expect(submitted.value.status).toBe("waiting-restart");
      await waitFor(() => app!.processExitCode() !== null, 120000);
      expect(await app.stop()).toBe(75);
      let ready = false,
        startError: unknown,
        observedMaintenance = false,
        observedReadiness503 = false,
        progressReads = 0,
        last: DatabaseOperation | undefined;
      const starting = app
        .start()
        .then(() => {
          ready = true;
        })
        .catch((error) => {
          startError = error;
        });
      const deadline = performance.now() + 900000;
      while (!ready && !startError && performance.now() < deadline) {
        try {
          const response = await fetch(app.base + operationPath, {
            headers: { ...app.headers, "x-panda-database-operation": statusToken },
            signal: AbortSignal.timeout(5000),
          });
          if (response.status === 200) {
            last = (await response.json()) as DatabaseOperation;
            progressReads++;
            if (last.status === "running") observedMaintenance = true;
            if (last.status === "failed") throw Error("Migration failed: " + last.error?.code + " at " + last.stage);
          }
          const health = await fetch(app.base + "/health/readiness", { signal: AbortSignal.timeout(5000) });
          if (health.status === 503) observedReadiness503 = true;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Migration failed:")) throw error;
        }
        await Bun.sleep(100);
      }
      await starting;
      if (startError) throw startError;
      expect(ready).toBe(true);
      expect(progressReads).toBeGreaterThan(0);
      expect(observedMaintenance).toBe(true);
      expect(observedReadiness503).toBe(true);
      const completed = await fetch(app.base + operationPath, {
        headers: { ...app.headers, "x-panda-database-operation": statusToken },
      });
      expect(completed.status).toBe(200);
      expect((await completed.json()).status).toBe("complete");
      const overview = await call("/api/system/database");
      expect(overview.value.current.driver).toBe("mysql");
      expect(overview.value.readiness.ready).toBe(true);
      const projects = await call("/api/projects");
      expect(projects.status).toBe(200);
      expect(projects.value.projects[0].id).toBe(projectId);
      expect((await call("/api/auth/login", { username: "migration-owner", password: "visibility-test" })).status).toBe(
        200,
      );
      const importedSkills = await call("/api/skill-packs?limit=10");
      expect(importedSkills.status).toBe(200);
      expect(
        importedSkills.value.packages.map((pack: { id: string; version: string; digest: string; active: boolean }) => ({
          id: pack.id,
          version: pack.version,
          digest: pack.digest,
          active: pack.active,
        })),
      ).toEqual(skillRecords);
      expect(await database.sql.unsafe("SELECT id FROM panda_force_projects WHERE id=?", [projectId])).toHaveLength(1);
      for (const path of original) await access(path);
      const nativeFiles = await liveSQLiteFiles(stateRoot);
      expect(nativeFiles.map((path) => relative(stateRoot, path))).toEqual(
        original.map((path) => relative(stateRoot, path)),
      );
      await app.stop();
      await app.start();
      expect((await call("/api/projects")).value.projects[0].id).toBe(projectId);
      expect((await call("/api/system/database")).value.current.driver).toBe("mysql");
      expect(await liveSQLiteFiles(stateRoot)).toEqual(nativeFiles);
    } finally {
      await app?.dispose();
      await database.close();
    }
  },
  1200000,
);
