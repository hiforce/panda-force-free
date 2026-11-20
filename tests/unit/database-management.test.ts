import { afterEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DatabaseConnectionInput,
  DatabaseMigrationRequest,
  DatabaseTargetSummary,
} from "../../src/shared/database/contracts.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import {
  DatabaseManagementService,
  type DatabaseManagementOptions,
} from "../../src/server/database/management/service.js";
import {
  DatabaseManagementState,
  type StoredDatabaseOperation,
  type StoredDatabasePlan,
} from "../../src/server/database/management/state.js";
import { databaseManagementRoutes } from "../../src/server/database/management/routes.js";
import { createRouter } from "../../src/server/http/router.js";
import { bootstrapApplicationDatabase } from "../../src/server/database/bootstrap.js";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});
test("database choice survives a restart before the first browser and preserves an explicit selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-first-database-choice-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const env = { PANDA_FORCE_HOME: root, CODEX_HOME: join(root, "model"), HOME: join(root, "home") };
  const first = await bootstrapApplicationDatabase(root, { env, initialChoiceRequired: true });
  await first.close();
  const state = new DatabaseManagementState(root);
  const initial = await state.installation(false);
  expect(initial.initialChoiceRequired).toBe(true);
  const catalog = new ProjectCatalog(join(root, "data", "projects.sqlite"));
  catalog.close();
  const restarted = await bootstrapApplicationDatabase(root, { env, initialChoiceRequired: false });
  await restarted.close();
  expect(await state.installation(false)).toEqual(initial);
  await state.write("", "installation", { ...initial, initialChoiceRequired: false });
  const selected = await bootstrapApplicationDatabase(root, { env, initialChoiceRequired: true });
  await selected.close();
  expect((await state.installation(true)).initialChoiceRequired).toBe(false);
  expect((await state.installation(true)).id).toBe(initial.id);
});
const input: DatabaseConnectionInput = {
  hostname: "isolated.mysql.invalid",
  port: 3306,
  database: "panda_fixture",
  username: "PRIVATE_USER_SENTINEL",
  password: "PRIVATE_PASSWORD_SENTINEL",
  tls: { mode: "verify", caFile: "/private/CA_SENTINEL.pem" },
  max: 4,
  connectionTimeout: 3,
  idleTimeout: 15,
};
const token = () => randomBytes(32).toString("base64url");
const request = (planId: string): DatabaseMigrationRequest => ({
  planId,
  requestId: randomUUID(),
  statusToken: token(),
});
function registry() {
  const result = new DatabaseRegistry();
  for (const id of ["documents", "bots"])
    result.register({
      id,
      dependencies: [],
      migrations: {
        mysql: [
          {
            version: 1,
            steps: [{ id: "create", sql: `CREATE TABLE ${id}_fixture (id INT)`, satisfied: async () => true }],
          },
        ],
      },
      backends: { mysql: { readWrite: true, importFrom: ["sqlite"] } },
      inspect: async () => [],
    });
  return result;
}
async function fixture(overrides: Partial<DatabaseManagementOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "panda-database-management-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const state = new DatabaseManagementState(root);
  let closes = 0,
    connects = 0;
  const sql = Object.assign(async () => [{ version: "8.0.40", mode: "STRICT_TRANS_TABLES" }], {
    close: async () => {
      closes++;
    },
  }) as unknown as SQL;
  const options: DatabaseManagementOptions = {
    state,
    registry,
    runtimeBindings: () => new Set(["documents", "bots"]),
    current: () => ({ driver: "sqlite" }),
    initialChoiceRequired: true,
    tableCount: () => 2,
    connect: async () => {
      connects++;
      return sql;
    },
    requestRestart: () => {},
    ...overrides,
  };
  const service = new DatabaseManagementService(options);
  const plan = () => service.plan("administrator", input);
  const record = async (id: string) => (await state.read<StoredDatabaseOperation>("operations", id))!;
  const transition = async (id: string, patch: Partial<StoredDatabaseOperation["public"]>) => {
    const value = await record(id);
    value.public = { ...value.public, ...patch };
    await state.write("operations", id, value);
    return value;
  };
  return { root, state, service, options, plan, record, transition, counts: () => ({ closes, connects }) };
}
async function httpFixture(f: Awaited<ReturnType<typeof fixture>>, capability = false, currentOperationId?: string) {
  const handlers = databaseManagementRoutes({
    service: f.service,
    owner: () => "administrator",
    administrator: (ctx) => ctx.req.headers["x-test-admin"] === "yes",
  });
  const router = createRouter(handlers.routes);
  let server: Server;
  server = createServer((req, res) => {
    const context = { req, res, url: new URL(req.url!, `http://${req.headers.host}`) };
    void (capability ? handlers.handleCapability(context, currentOperationId) : router(context))
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing fixture address");
  const base = `http://127.0.0.1:${address.port}`;
  disposals.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return async (
    path = "",
    body?: unknown,
    options: { admin?: boolean; origin?: string; operationToken?: string; raw?: string } = {},
  ) => {
    const response = await fetch(base + "/api/system/database" + path, {
      method: body === undefined && options.raw === undefined ? "GET" : "POST",
      headers: {
        ...(options.admin ? { "x-test-admin": "yes" } : {}),
        origin: options.origin ?? base,
        "content-type": "application/json",
        ...(options.operationToken ? { "x-panda-database-operation": options.operationToken } : {}),
      },
      ...(body !== undefined || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, value: text ? JSON.parse(text) : null };
  };
}
function noCredentials(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [
    input.username,
    input.password,
    "CA_SENTINEL",
    '"config"',
    '"statusTokenHash"',
    '"tokenExpiresAt"',
    '"owner"',
  ])
    expect(text).not.toContain(secret);
}

describe("database management protocol", () => {
  test("administrator and Origin protect every normal mutation, including token-bearing recovery", async () => {
    const f = await fixture(),
      api = await httpFixture(f);
    expect((await api()).value).toEqual({
      schema: 1,
      administrator: false,
      initialChoiceRequired: false,
      current: { driver: "sqlite" },
      readiness: { ready: false, modules: [], issues: [] },
    });
    for (const path of ["/test", "/plan", "/migrate", "/selection"]) {
      expect((await api(path, input)).status).toBe(403);
      expect((await api(path, input, { admin: true, origin: "https://untrusted.invalid" })).status).toBe(403);
    }
    expect(f.counts().connects).toBe(0);
    const plan = await f.plan(),
      req = request(plan.id);
    await f.service.migrate("administrator", req);
    for (const action of ["retry", "cancel"])
      expect(
        (await api(`/operations/${req.requestId}/${action}`, {}, { operationToken: req.statusToken })).status,
      ).toBe(403);
    expect((await f.record(req.requestId)).public.status).toBe("waiting-restart");
  });

  test("only public summaries are returned and private plans use owner-only files", async () => {
    const f = await fixture(),
      api = await httpFixture(f);
    const tested = await api("/test", input, { admin: true });
    expect(tested.status).toBe(200);
    expect(tested.value).toEqual({ ok: true, serverVersion: "8.0.40", strictMode: true, issues: [] });
    const planned = await api("/plan", input, { admin: true });
    expect(planned.status).toBe(200);
    expect(planned.value.ready).toBe(true);
    const planFile = join(f.state.root, "plans", planned.value.id + ".json");
    expect((await lstat(planFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(planFile, "utf8")).toContain(input.password);
    const req = request(planned.value.id),
      migrated = await api("/migrate", req, { admin: true });
    expect(migrated.status).toBe(202);
    for (const response of [
      tested,
      planned,
      migrated,
      await api("", undefined, { admin: true }),
      await api(`/operations/${req.requestId}`, undefined, { operationToken: req.statusToken }),
    ]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      noCredentials(response.value);
      expect(response.text).not.toContain(req.statusToken);
    }
    expect(f.counts()).toEqual({ connects: 2, closes: 2 });
  });

  test("lost response recovers the same durable operation after service reconstruction and plan expiry", async () => {
    const f = await fixture(),
      plan = await f.plan(),
      req = request(plan.id);
    const admitted = await f.service.migrate("administrator", req);
    const stored = (await f.state.read<StoredDatabasePlan>("plans", plan.id))!;
    stored.public.expiresAt = Date.now() - 1;
    await f.state.write("plans", plan.id, stored);
    const recovered = new DatabaseManagementService({ ...f.options, state: new DatabaseManagementState(f.root) });
    expect(await recovered.migrate("administrator", req)).toEqual(admitted);
    expect(await recovered.operation(req.requestId, req.statusToken)).toEqual(admitted);
    await expect(recovered.migrate("administrator", { ...req, statusToken: token() })).rejects.toMatchObject({
      code: "operationTokenInvalid",
      status: 401,
    });
    await expect(recovered.migrate("different-owner", req)).rejects.toMatchObject({ code: "migrationAlreadyRunning" });
    await expect(recovered.migrate("administrator", { ...req, planId: randomUUID() })).rejects.toMatchObject({
      code: "migrationAlreadyRunning",
    });
    await expect(recovered.operation(randomUUID(), token())).rejects.toMatchObject({
      code: "operationNotFound",
      status: 404,
    });
    expect(await readdir(join(f.state.root, "operations"))).toHaveLength(1);
  });

  for (const status of ["waiting-restart", "running", "failed"] as const) {
    test(`expired capability keeps current ${status} maintenance recoverable`, async () => {
      const f = await fixture(),
        plan = await f.plan(),
        req = request(plan.id);
      await f.service.migrate("administrator", req);
      const record = await f.record(req.requestId);
      record.public = {
        ...record.public,
        status,
        stage: status === "waiting-restart" ? "restart" : status === "running" ? "copy" : "failed",
        canRetry: status === "failed",
      };
      record.tokenExpiresAt = Date.now() - 1000;
      await f.state.write("operations", req.requestId, record);
      expect((await f.service.operation(req.requestId, req.statusToken)).status).toBe(status);
      await expect(f.service.operation(req.requestId, token())).rejects.toMatchObject({
        code: "operationTokenInvalid",
        status: 401,
      });
      const api = await httpFixture(f, true, req.requestId);
      expect((await api(`/operations/${req.requestId}`, undefined, { operationToken: req.statusToken })).status).toBe(
        200,
      );
      expect(
        (
          await api(
            `/operations/${req.requestId}/retry`,
            {},
            { operationToken: req.statusToken, origin: "https://untrusted.invalid" },
          )
        ).status,
      ).toBe(403);
      expect((await api(`/operations/${req.requestId}/retry`, {}, { operationToken: req.statusToken })).status).toBe(
        200,
      );
      expect((await f.record(req.requestId)).statusTokenHash).toBe(record.statusTokenHash);
    });
  }

  test("expired historical and terminal capabilities stay invalid even with a matching pending id", async () => {
    const f = await fixture(),
      plan = await f.plan(),
      req = request(plan.id);
    await f.service.migrate("administrator", req);
    const record = await f.record(req.requestId);
    record.tokenExpiresAt = Date.now() - 1000;
    await f.state.write("operations", req.requestId, record);
    await f.state.clearPending(req.requestId);
    await expect(f.service.operation(req.requestId, req.statusToken)).rejects.toMatchObject({
      code: "operationTokenInvalid",
      status: 401,
    });
    await f.state.write("", "pending", { schema: 1, operationId: randomUUID() });
    await expect(f.service.operation(req.requestId, req.statusToken)).rejects.toMatchObject({
      code: "operationTokenInvalid",
      status: 401,
    });
    await f.state.write("", "pending", { schema: 1, operationId: req.requestId });
    for (const status of ["complete", "canceled"] as const) {
      record.public = { ...record.public, status, canRetry: false, canCancel: false };
      await f.state.write("operations", req.requestId, record);
      await expect(f.service.operation(req.requestId, req.statusToken)).rejects.toMatchObject({
        code: "operationTokenInvalid",
        status: 401,
      });
    }
    record.public.status = "failed";
    record.tokenExpiresAt = Number.NaN;
    await f.state.write("operations", req.requestId, record);
    await expect(f.service.operation(req.requestId, req.statusToken)).rejects.toMatchObject({
      code: "operationTokenInvalid",
      status: 401,
    });
  });

  test("concurrent admissions across state objects leave exactly one pending operation and no rejected receipt", async () => {
    const f = await fixture(),
      plan = await f.plan();
    const other = new DatabaseManagementService({ ...f.options, state: new DatabaseManagementState(f.root) });
    const requests = Array.from({ length: 8 }, () => request(plan.id));
    const outcomes = await Promise.allSettled(
      requests.map((value, index) => (index % 2 ? other : f.service).migrate("administrator", value)),
    );
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of outcomes)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "migrationAlreadyRunning", status: 409 });
    const files = await readdir(join(f.state.root, "operations"));
    expect(files).toHaveLength(1);
    expect((await f.state.read<{ operationId: string }>("", "pending"))?.operationId + ".json").toBe(files[0]);
  });

  test("expired, changed-source, and wrong-owner plans cannot admit an operation", async () => {
    let current: DatabaseTargetSummary = { driver: "sqlite" };
    const f = await fixture({ current: () => current }),
      plan = await f.plan();
    await expect(f.service.migrate("other", request(plan.id))).rejects.toMatchObject({ code: "migrationPlanExpired" });
    const stored = (await f.state.read<StoredDatabasePlan>("plans", plan.id))!;
    stored.public.expiresAt = Date.now() - 1;
    await f.state.write("plans", plan.id, stored);
    await expect(f.service.migrate("administrator", request(plan.id))).rejects.toMatchObject({
      code: "migrationPlanExpired",
    });
    const fresh = await f.plan();
    current = { driver: "mysql", hostname: "changed.invalid", port: 3306, database: "changed" };
    await expect(f.service.migrate("administrator", request(fresh.id))).rejects.toMatchObject({
      code: "migrationPlanExpired",
    });
    expect(await f.state.read("", "pending")).toBeNull();
  });

  test("readiness is rechecked at admission and target inspection cannot silently pass", async () => {
    let bound = true;
    const f = await fixture({ runtimeBindings: () => (bound ? new Set(["documents", "bots"]) : new Set(["bots"])) });
    const plan = await f.plan();
    bound = false;
    await expect(f.service.migrate("administrator", request(plan.id))).rejects.toMatchObject({
      code: "incompleteDatabaseBackend",
      status: 409,
    });
    const blocked = await f.plan();
    expect(blocked.ready).toBe(false);
    expect(blocked.issues).toContainEqual({ code: "incompleteDatabaseBackend", module: "documents" });
    const inspected = await fixture({
      inspectTarget: async () => [{ code: "databaseSchemaDrift", module: "documents" }],
    });
    expect((await inspected.plan()).ready).toBe(false);
    const unavailable = await fixture({ requestRestart: undefined });
    expect((await unavailable.plan()).issues).toContainEqual({ code: "restartUnavailable" });
  });

  test("Bot MySQL stays in place and a different native target is blocked before restart", async () => {
    const target: DatabaseTargetSummary = {
      driver: "mysql",
      hostname: input.hostname,
      port: input.port,
      database: input.database,
    };
    let bot = target;
    const f = await fixture({ bot: () => bot });
    const matching = await f.plan();
    expect(matching.ready).toBe(true);
    expect(matching.modules.find((m) => m.module === "bots")?.action).toBe("preserve");
    bot = { ...target, database: "another_bot_database" };
    const mismatch = await f.plan();
    expect(mismatch.ready).toBe(false);
    expect(mismatch.issues).toContainEqual({ code: "botDatabaseTargetMismatch", module: "bots" });
    expect(mismatch.modules.find((m) => m.module === "bots")?.action).toBe("preserve");
    await expect(f.service.migrate("administrator", request(matching.id))).rejects.toMatchObject({
      code: "botDatabaseTargetMismatch",
      status: 409,
    });
  });

  test("native MySQL source remains inspectable but every migration plan is explicitly unsupported", async () => {
    const f = await fixture({
      current: () => ({ driver: "mysql", hostname: "current.invalid", port: 3306, database: "current" }),
    });
    expect((await f.service.test(input)).ok).toBe(true);
    expect((await f.service.overview(true)).current.driver).toBe("mysql");
    const plan = await f.plan();
    expect(plan.ready).toBe(false);
    expect(plan.issues).toContainEqual({ code: "unsupportedMigrationSource" });
  });

  test("retry and cancel are idempotent and obey persisted transition capabilities", async () => {
    const f = await fixture(),
      plan = await f.plan(),
      req = request(plan.id);
    await f.service.migrate("administrator", req);
    await f.transition(req.requestId, { status: "running", stage: "copy", canCancel: false });
    await expect(f.service.cancel(req.requestId, req.statusToken)).rejects.toMatchObject({
      code: "cancelRequiresAdministrator",
      status: 409,
    });
    await f.transition(req.requestId, {
      status: "failed",
      stage: "failed",
      canRetry: true,
      canCancel: false,
      error: { code: "migrationFailed" },
    });
    const retry = await f.service.retry(req.requestId, req.statusToken);
    expect(retry).toMatchObject({ id: req.requestId, status: "waiting-restart", stage: "restart", canRetry: false });
    expect(retry.error).toBeUndefined();
    expect(await f.service.retry(req.requestId, req.statusToken)).toEqual(retry);
    await f.transition(req.requestId, { canCancel: true });
    const canceled = await f.service.cancel(req.requestId, req.statusToken);
    expect(canceled).toMatchObject({ status: "canceled", canCancel: false, canRetry: false });
    expect(await f.service.cancel(req.requestId, req.statusToken)).toEqual(canceled);
    expect(await f.state.read("", "pending")).toBeNull();
    await expect(f.service.retry(req.requestId, req.statusToken)).rejects.toMatchObject({
      code: "migrationAlreadyActivated",
    });
  });

  test("an older operation cannot change state while another operation owns the pending marker", async () => {
    const f = await fixture(),
      plan = await f.plan(),
      older = request(plan.id);
    await f.service.migrate("administrator", older);
    await f.transition(older.requestId, { status: "failed", stage: "failed", canRetry: true, canCancel: true });
    await f.state.clearPending(older.requestId);
    const active = request(plan.id);
    await f.service.migrate("administrator", active);
    await expect(f.service.cancel(older.requestId, older.statusToken)).rejects.toMatchObject({
      code: "migrationAlreadyRunning",
    });
    expect((await f.record(older.requestId)).public.status).toBe("failed");
    expect((await f.state.read<{ operationId: string }>("", "pending"))?.operationId).toBe(active.requestId);
  });

  test("an idempotent waiting-restart retry restores a missing pending marker", async () => {
    const f = await fixture(),
      plan = await f.plan(),
      req = request(plan.id);
    await f.service.migrate("administrator", req);
    await f.state.clearPending(req.requestId);
    expect((await f.service.retry(req.requestId, req.statusToken)).status).toBe("waiting-restart");
    expect((await f.state.read<{ operationId: string }>("", "pending"))?.operationId).toBe(req.requestId);
  });

  test("maintenance capability is current-operation scoped, Origin checked, and works without a session", async () => {
    const f = await fixture(),
      plan = await f.plan(),
      req = request(plan.id);
    await f.service.migrate("administrator", req);
    const api = await httpFixture(f, true, req.requestId);
    expect((await api(`/operations/${req.requestId}`, undefined, { operationToken: req.statusToken })).status).toBe(
      200,
    );
    expect(
      (
        await api(
          `/operations/${req.requestId}/cancel`,
          {},
          { operationToken: req.statusToken, origin: "https://untrusted.invalid" },
        )
      ).status,
    ).toBe(403);
    expect((await api(`/operations/${req.requestId}/cancel`, {}, { operationToken: token() })).status).toBe(401);
    expect((await api(`/operations/${req.requestId}/cancel`, {}, { operationToken: req.statusToken })).status).toBe(
      200,
    );
    const next = request(plan.id);
    await f.service.migrate("administrator", next);
    const current = await httpFixture(f, true, next.requestId);
    expect((await current(`/operations/${req.requestId}`, undefined, { operationToken: req.statusToken })).status).toBe(
      404,
    );
    expect(
      (await current(`/operations/${next.requestId}`, undefined, { operationToken: next.statusToken })).status,
    ).toBe(200);
    const implicit = await httpFixture(f, true);
    expect(
      (await implicit(`/operations/${req.requestId}`, undefined, { operationToken: req.statusToken })).status,
    ).toBe(404);
  });

  test("SQLite selection is explicit, durable, and unavailable during migration or after native cutover", async () => {
    let current: DatabaseTargetSummary = { driver: "sqlite" };
    const f = await fixture({ current: () => current }),
      api = await httpFixture(f);
    expect((await f.service.overview(true)).initialChoiceRequired).toBe(true);
    expect((await api("/selection", { driver: "sqlite" }, { admin: true })).value.initialChoiceRequired).toBe(false);
    expect(
      (await new DatabaseManagementService({ ...f.options, state: new DatabaseManagementState(f.root) }).overview(true))
        .initialChoiceRequired,
    ).toBe(false);
    const plan = await f.plan();
    await f.service.migrate("administrator", request(plan.id));
    await expect(f.service.selectSQLite()).rejects.toMatchObject({ code: "migrationAlreadyRunning" });
    current = { driver: "mysql" };
    await expect(f.service.selectSQLite()).rejects.toMatchObject({ code: "rollbackRequiresMigration" });
  });

  test("malformed bodies and connector errors expose stable errors without driver text or credentials", async () => {
    const f = await fixture({
        connect: async () => {
          throw Error(input.password + ": raw driver details");
        },
      }),
      api = await httpFixture(f);
    const failed = await api("/test", input, { admin: true });
    expect(failed.value).toEqual({ ok: false, issues: [{ code: "connectionFailed" }] });
    noCredentials(failed.value);
    for (const raw of ["{broken", "[]", "null"])
      expect(await api("/test", undefined, { admin: true, raw })).toMatchObject({
        status: 400,
        value: { error: { code: "invalidDatabaseConfiguration" } },
      });
    expect((await api("/test", { ...input, max: 1 }, { admin: true })).status).toBe(400);
  });
});

describe("private expired plan retention", () => {
  test("only expired unreferenced plans are removed; failed retries and pending plans retain credentials", async () => {
    const f = await fixture();
    const expire = async (id: string) => {
      const value = (await f.state.read<StoredDatabasePlan>("plans", id))!;
      value.public.expiresAt = Date.now() - 1;
      await f.state.write("plans", id, value);
    };
    const orphan = await f.plan(),
      live = await f.plan(),
      failedPlan = await f.plan(),
      pendingPlan = await f.plan();
    const failed = request(failedPlan.id);
    await f.service.migrate("administrator", failed);
    await f.transition(failed.requestId, { status: "failed", stage: "failed", canRetry: true, canCancel: false });
    await f.state.clearPending(failed.requestId);
    const pending = request(pendingPlan.id);
    await f.service.migrate("administrator", pending);
    await Promise.all([orphan, failedPlan, pendingPlan].map((plan) => expire(plan.id)));
    await f.service.overview(true);
    expect(await f.state.read("plans", orphan.id)).toBeNull();
    for (const id of [live.id, failedPlan.id, pendingPlan.id]) expect(await f.state.read("plans", id)).not.toBeNull();
    await f.service.cancel(pending.requestId, pending.statusToken);
    await f.service.overview(true);
    expect(await f.state.read("plans", pendingPlan.id)).toBeNull();
    expect((await f.service.retry(failed.requestId, failed.statusToken)).status).toBe("waiting-restart");
    expect((await f.state.read<StoredDatabasePlan>("plans", failedPlan.id))?.config.mysql.password).toBe(
      input.password,
    );
  });

  test("cleanup is bounded and leaves symlinks, public-mode files and unrelated paths untouched", async () => {
    const f = await fixture(),
      original = await f.plan();
    const value = (await f.state.read<StoredDatabasePlan>("plans", original.id))!;
    const ids = Array.from({ length: 6 }, () => randomUUID());
    for (const id of ids)
      await f.state.write("plans", id, { ...value, public: { ...value.public, id, expiresAt: Date.now() - 1 } });
    const outside = join(f.root, "outside.json");
    await writeFile(outside, JSON.stringify({ ...value, public: { ...value.public, expiresAt: Date.now() - 1 } }), {
      mode: 0o600,
    });
    const linkId = randomUUID();
    await symlink(outside, join(f.state.root, "plans", linkId + ".json"));
    const publicId = randomUUID();
    await f.state.write("plans", publicId, {
      ...value,
      public: { ...value.public, id: publicId, expiresAt: Date.now() - 1 },
    });
    const publicPath = join(f.state.root, "plans", publicId + ".json");
    await chmod(publicPath, 0o644);
    await writeFile(join(f.state.root, "plans", "unrelated.json"), "keep", { mode: 0o600 });
    expect(await f.state.pruneExpiredPlans(Date.now(), 2)).toBe(2);
    expect(
      (await readdir(join(f.state.root, "plans"))).filter((file) => ids.some((id) => file === id + ".json")),
    ).toHaveLength(4);
    await f.state.pruneExpiredPlans(Date.now(), 2);
    await f.state.pruneExpiredPlans(Date.now(), 2);
    const remaining = await readdir(join(f.state.root, "plans"));
    expect(remaining).toContain(publicId + ".json");
    expect(remaining).toContain(linkId + ".json");
    expect(remaining).toContain("unrelated.json");
    expect(remaining.some((file) => ids.some((id) => file === id + ".json"))).toBe(false);
    expect((await lstat(join(f.state.root, "plans", linkId + ".json"))).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toContain(input.password);
  });

  test("terminal receipts retain a pending plan until handoff, and unreadable references stop cleanup", async () => {
    const f = await fixture(),
      plan = await f.plan(),
      req = request(plan.id);
    await f.service.migrate("administrator", req);
    await f.transition(req.requestId, { status: "complete", stage: "complete", canCancel: false });
    const saved = (await f.state.read<StoredDatabasePlan>("plans", plan.id))!;
    saved.public.expiresAt = Date.now() - 1;
    await f.state.write("plans", plan.id, saved);
    expect(await f.state.pruneExpiredPlans()).toBe(0);
    await f.state.clearPending(req.requestId);
    const unknown = randomUUID();
    await f.state.write("operations", unknown, { schema: 2 });
    expect(await f.state.pruneExpiredPlans()).toBe(0);
    expect(await f.state.read("plans", plan.id)).not.toBeNull();
    await rm(join(f.state.root, "operations", unknown + ".json"));
    expect(await f.state.pruneExpiredPlans()).toBe(1);
    expect(await f.state.read("operations", req.requestId)).not.toBeNull();
  });

  test("a symlinked plan directory is rejected before reading or cleanup", async () => {
    const f = await fixture(),
      external = await mkdtemp(join(tmpdir(), "panda-database-management-external-"));
    disposals.push(() => rm(external, { recursive: true, force: true }));
    await f.state.directory();
    await symlink(external, join(f.state.root, "plans"));
    await expect(f.state.read("plans", randomUUID())).rejects.toMatchObject({
      code: "databaseUnavailable",
      status: 503,
    });
    await expect(f.state.pruneExpiredPlans()).rejects.toMatchObject({ code: "databaseUnavailable", status: 503 });
    expect(await readdir(external)).toHaveLength(0);
  });
});
