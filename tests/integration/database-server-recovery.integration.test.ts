import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { createAppFixture } from "../support/app-fixture.mjs";
import { createApplicationDatabaseRegistry } from "../../src/server/database/application-registry.js";
import { MySQLSchemaConnection } from "../../src/server/database/mysql-schema.js";
import { databaseConfiguration } from "../../src/server/database/config.js";
import { DatabaseManagementState } from "../../src/server/database/management/state.js";
import {
  claimApplicationDatabase,
  activateApplicationDatabase,
  databaseTargetHash,
} from "../../src/server/database/migration/activation.js";

const guarded = test.skipIf(process.env.PANDA_FORCE_TEST_MYSQL_RECOVERY_DOCKER !== "1");
guarded(
  "application survives a real MySQL server restart and recovers business reads without an application restart",
  async () => {
    const name = "panda-db-recovery-" + randomUUID().slice(0, 8),
      password = randomUUID();
    const docker = async (...args: string[]) => {
      const child = Bun.spawn(["docker", ...args], {
        env: { ...process.env, MYSQL_ROOT_PASSWORD: password },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code) throw Error("Isolated MySQL command failed: " + args[0] + ": " + error);
      return (args[0] === "logs" ? output + error : output).trim();
    };
    const volume = name + "-data",
      holder = name + "-holder";
    let admin: SQL | undefined, app: Awaited<ReturnType<typeof createAppFixture>> | undefined;
    let restart: Promise<string> | undefined;
    try {
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const port = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      await docker(
        "volume",
        "create",
        "--label",
        "panda-force.qa=mysql-recovery",
        "--driver",
        "local",
        "--opt",
        "type=tmpfs",
        "--opt",
        "device=tmpfs",
        "--opt",
        "o=size=1073741824",
        volume,
      );
      // Keep the isolated data volume mounted across actual database container stops.
      await docker(
        "run",
        "-d",
        "--name",
        holder,
        "--mount",
        "type=volume,source=" + volume + ",target=/keep",
        "--entrypoint",
        "/bin/sh",
        "mysql:8.0.45",
        "-c",
        "sleep 600",
      );
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "panda-force.qa=mysql-recovery",
        "--mount",
        "type=volume,source=" + volume + ",target=/var/lib/mysql",
        "--memory=2g",
        "--cpus=2",
        "-p",
        `127.0.0.1:${port}:3306`,
        "-e",
        "MYSQL_ROOT_PASSWORD",
        "-e",
        "MYSQL_DATABASE=panda_force_test",
        "-e",
        "MYSQL_INITDB_SKIP_TZINFO=1",
        "mysql:8.0.45",
        "--default-authentication-plugin=mysql_native_password",
        "--innodb-buffer-pool-size=64M",
      );
      expect(Number((await docker("port", name, "3306")).split(":").at(-1))).toBe(port);
      const deadline = Date.now() + 120000;
      while (!admin) {
        const candidate = new SQL({
          adapter: "mysql",
          hostname: "127.0.0.1",
          port,
          database: "panda_force_test",
          username: "root",
          password,
          tls: false,
          max: 2,
          connectionTimeout: 1,
          idleTimeout: 5,
        });
        try {
          await candidate`SELECT 1`;
          admin = candidate;
        } catch (error) {
          await candidate.close().catch(() => {});
          if (Date.now() >= deadline) throw error;
          await Bun.sleep(500);
        }
      }
      await createApplicationDatabaseRegistry().upgrade(new MySQLSchemaConnection(admin));
      const config = databaseConfiguration({
        schema: 1,
        driver: "mysql",
        mysql: {
          hostname: "127.0.0.1",
          port,
          database: "panda_force_test",
          username: "root",
          password,
          tls: { mode: "disabled" },
          max: 4,
          connectionTimeout: 2,
          idleTimeout: 5,
          maxLifetime: 60,
        },
      });
      if (config.driver !== "mysql") throw Error("Expected MySQL");
      app = await createAppFixture({
        startupTimeoutMs: 120000,
        prepareState: async ({ stateRoot }) => {
          const state = new DatabaseManagementState(stateRoot),
            installation = await state.installation(false);
          const activation = {
            schema: 1 as const,
            installationId: installation.id,
            operationId: randomUUID(),
            targetHash: databaseTargetHash(config),
          };
          await claimApplicationDatabase(admin!, activation);
          await activateApplicationDatabase({ sql: admin!, state, activation, config });
          await admin!.close();
          admin = undefined;
          await docker("stop", "--time=1", name);
          restart = (async () => {
            await Bun.sleep(2000);
            return docker("start", name);
          })();
        },
      });
      await restart;
      const status = async (path: string) =>
        (await fetch(app!.base + path, { headers: app!.headers, signal: AbortSignal.timeout(4000) })).status;
      expect(await status("/health/readiness")).toBe(200);
      const catalog = await (await fetch(app.base + "/api/projects", { headers: app.headers })).json();
      const created = await fetch(app.base + "/api/projects", {
        method: "POST",
        headers: { ...app.headers, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Database recovery marker",
          code: "database-recovery-marker",
          operationId: "recovery-marker",
          revision: catalog.revision,
        }),
      });
      expect(created.status).toBe(201);
      const before = await (await fetch(app.base + "/api/projects", { headers: app.headers })).json();
      expect(before.projects).toHaveLength(1);
      expect(before.projects[0].code).toBe("database-recovery-marker");
      await docker("stop", "--time=1", name);
      await Bun.sleep(5100);
      expect(await status("/health/readiness")).toBe(503);
      expect(await status("/health/liveness")).toBe(200);
      expect(app.processExitCode()).toBeNull();
      await docker("start", name);
      let recovered = false;
      const recoveryDeadline = Date.now() + 60000;
      while (Date.now() < recoveryDeadline) {
        if ((await status("/health/readiness")) === 200) {
          recovered = true;
          break;
        }
        await Bun.sleep(500);
      }
      expect(recovered).toBe(true);
      expect(app.processExitCode()).toBeNull();
      const response = await fetch(app.base + "/api/projects", { headers: app.headers });
      expect(response.status).toBe(200);
      expect((await response.json()).projects).toEqual(before.projects);
    } catch (error) {
      const log = await docker("logs", name).catch(() => "unavailable");
      await Bun.write(
        ".artifacts/panda-net-startup-failure/isolated-server-failure.private.json",
        JSON.stringify({ error: String(error), log }),
      );
      throw error;
    } finally {
      await restart?.catch(() => {});
      await app?.dispose();
      await admin?.close().catch(() => {});
      await docker("rm", "--force", "--volumes", name).catch(() => {});
      await docker("rm", "--force", "--volumes", holder).catch(() => {});
      await docker("volume", "rm", volume).catch(() => {});
    }
  },
  360000,
);
