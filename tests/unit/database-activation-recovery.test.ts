import { expect, test } from "bun:test";

/** Module mocks live in a separate process; other database suites retain their real connectors. */
async function recoveryAfterCleanupFailure(mode: "close" | "clear-before" | "clear-after") {
  const script = String.raw`
    import { mock } from "bun:test";
    import { randomUUID, createHash } from "node:crypto";
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const source = name => pathToFileURL(join(process.cwd(), "src/server/database/", name)).href;
    const mode = process.argv.at(-1);
    const root = await mkdtemp(join(tmpdir(), "pf-activation-recovery-"));
    const operationId = randomUUID(), planId = randomUUID();
    const owner = "fixture-administrator", statusToken = "A".repeat(43);
    let target = null, closes = 0, maintenanceCloses = 0;
    const query = async (parts, ...values) => {
      const text = parts.join("?");
      if (text.includes("information_schema.TABLES")) return [];
      if (text.includes("IS_USED_LOCK")) return [{ owned: 1 }];
      if (text.includes("GET_LOCK")) return [{ acquired: 1 }];
      if (text.includes("RELEASE_LOCK")) return [{ released: 1 }];
      if (text.startsWith("INSERT INTO panda_force_database_installation")) {
        target ??= { installationId: values[0], operationId: values[1], targetHash: values[2], state: "staging" };
        return [];
      }
      if (text.startsWith("SELECT installationId")) return target ? [{ ...target }] : [];
      if (text.startsWith("UPDATE panda_force_database_installation")) { target.state = "active"; return []; }
      throw Error("Unexpected fake SQL query " + text);
    };
    const sql = Object.assign(query, {
      begin: async work => work(sql), reserve: async () => sql, release() {},
      close: async () => { closes++; if (mode === "close") throw Error("Fixture cleanup connection failure"); },
    });
    const registry = { ordered: () => [], readiness: () => [], assertCutoverReady() {}, upgrade: async () => [], inspect: async () => [] };
    mock.module(source("provider.js"), () => ({ connectMySQL: async () => sql }));
    mock.module(source("application-registry.js"), () => ({ createApplicationDatabaseRegistry: () => registry }));
    mock.module(source("runtime-stores.js"), () => ({ applicationMySQLRuntimeBindings: [] }));
    mock.module(source("maintenance.js"), () => ({ startDatabaseMaintenance: async () => ({ close: async () => { maintenanceCloses++; } }) }));
    mock.module(source("migration/legacy-sources.js"), () => ({
      createLegacySQLiteMigrationSources: async () => ({
        units: [], prepare: async () => ({ schema: 1, operationId, sources: [], preservedModules: [], unitsFingerprint: createHash("sha256").update("[]").digest("hex") }),
      }),
    }));
    const { DatabaseManagementState } = await import(source("management/state.js"));
    const { recoverPendingApplicationMigration } = await import(source("migration/recovery.js"));
    const { readApplicationDatabaseConfig } = await import(source("config.js"));
    const { assertApplicationDatabaseActivation } = await import(source("migration/activation.js"));
    const state = new DatabaseManagementState(root), now = Date.now();
    const config = { schema: 1, driver: "mysql", mysql: { hostname: "fixture.invalid", port: 3306, database: "fixture", username: "fixture", password: "fixture-only", tls: { mode: "disabled" }, max: 2, connectionTimeout: 5, idleTimeout: 30 } };
    const publicPlan = { id: planId, source: { driver: "sqlite" }, target: { driver: "mysql", hostname: "fixture.invalid", port: 3306, database: "fixture", tls: "disabled" }, restartRequired: true, ready: true, modules: [], issues: [], expiresAt: now + 60000 };
    await state.write("plans", planId, { schema: 1, owner, config, public: publicPlan });
    await state.write("operations", operationId, { schema: 1, owner, planId, statusTokenHash: createHash("sha256").update(statusToken).digest("hex"), tokenExpiresAt: now + 60000,
      public: { id: operationId, status: "waiting-restart", stage: "restart", source: publicPlan.source, target: publicPlan.target, modules: [], startedAt: now, updatedAt: now, canRetry: false, canCancel: true } });
    await state.write("", "pending", { schema: 1, operationId });
    if (mode.startsWith("clear-")) {
      const clear = state.clearPending.bind(state);
      let first = true;
      state.clearPending = async id => {
        if (!first) return clear(id);
        first = false;
        if (mode === "clear-after") await clear(id);
        throw Error("Fixture pending directory sync failure");
      };
    }
    const options = { host: "127.0.0.1", port: 0, publicDir: "/fixture-unused" };
    let timer;
    const completion = await Promise.race([
      recoverPendingApplicationMigration(state, options).then(() => "returned", error => "rejected:" + error.message),
      new Promise(resolve => { timer = setTimeout(() => resolve("timed-out"), 2000); }),
    ]);
    clearTimeout(timer);
    const record = await state.read("operations", operationId);
    const selected = await readApplicationDatabaseConfig(root);
    let activationValid = true;
    try { await assertApplicationDatabaseActivation(state, selected, sql); } catch { activationValid = false; }
    const pendingBeforeSecondStartup = await state.read("", "pending");
    let secondStartup = "not-attempted";
    if (record.public.status === "complete") {
      secondStartup = await recoverPendingApplicationMigration(state, options).then(() => "returned", error => "rejected:" + error.message);
    }
    const result = { mode, completion, status: record.public.status, stage: record.public.stage, canRetry: record.public.canRetry, canCancel: record.public.canCancel,
      selected: selected.driver, targetState: target?.state, activationValid, closes, maintenanceCloses,
      pendingBeforeSecondStartup: !!pendingBeforeSecondStartup, pendingAfterSecondStartup: !!(await state.read("", "pending")), secondStartup,
      capabilityRetained: record.statusTokenHash === createHash("sha256").update(statusToken).digest("hex") };
    await rm(root, { recursive: true, force: true });
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script, mode], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe(mode === "close" ? "[database] Migration connection cleanup could not complete\n" : "");
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

for (const mode of ["close", "clear-before", "clear-after"] as const) {
  test(`completed activation survives ${mode} cleanup rejection and startup recovery`, async () => {
    const result = await recoveryAfterCleanupFailure(mode);
    expect(result).toMatchObject({
      mode,
      completion: "returned",
      status: "complete",
      stage: "complete",
      canRetry: false,
      canCancel: false,
      selected: "mysql",
      targetState: "active",
      activationValid: true,
      maintenanceCloses: 1,
      secondStartup: "returned",
      pendingAfterSecondStartup: false,
      capabilityRetained: true,
    });
    expect(result.closes).toBe(1);
    expect(result.pendingBeforeSecondStartup).toBe(mode === "clear-before");
  }, 10000);
}
