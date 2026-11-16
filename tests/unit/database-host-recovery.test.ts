import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabaseHostRecovery,
  type DatabaseHostRecoveryMarker,
} from "../../src/server/database/management/host-recovery.js";
import { DatabaseManagementState, type StoredDatabaseOperation } from "../../src/server/database/management/state.js";
import { DatabaseManagementService } from "../../src/server/database/management/service.js";
import { databaseManagementRoutes } from "../../src/server/database/management/routes.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { recoverDatabaseOperation } from "../../src/server/database/recover.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pf-host-recovery-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const state = new DatabaseManagementState(root),
    operationId = randomUUID(),
    oldToken = token(),
    now = Date.now();
  const record: StoredDatabaseOperation = {
    schema: 1,
    owner: "fixture-admin",
    planId: randomUUID(),
    statusTokenHash: hash(oldToken),
    tokenExpiresAt: now + 60000,
    public: {
      id: operationId,
      status: "failed",
      stage: "failed",
      source: { driver: "sqlite" },
      target: { driver: "mysql", hostname: "fixture.invalid", database: "fixture" },
      modules: [{ module: "documents", stage: "verify", rows: 15 }],
      error: { code: "migrationFailed" },
      startedAt: now,
      updatedAt: now,
      canRetry: true,
      canCancel: false,
    },
  };
  await state.write("operations", operationId, record);
  await state.write("", "pending", { schema: 1, operationId });
  const recovery = await initializeDatabaseHostRecovery({ state, operationId });
  const marker = (await state.read<DatabaseHostRecoveryMarker>("", "host-recovery"))!;
  const service = new DatabaseManagementService({
    state,
    registry: () => new DatabaseRegistry(),
    runtimeBindings: () => new Set(),
    current: () => ({ driver: "sqlite" }),
    initialChoiceRequired: false,
    tableCount: () => 0,
    requestRestart: () => {},
  });
  const routes = databaseManagementRoutes({ service, administrator: () => false, owner: () => "" });
  let dropHost = false,
    dropRetry = false,
    redirectPublic = false,
    hostPosts = 0,
    retryPosts = 0;
  let beforeHost: (() => Promise<void>) | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const context = { req, res, url: new URL(req.url!, `http://${req.headers.host}`) };
      if (context.url.pathname === "/api/system/database/maintenance") {
        if (redirectPublic) {
          res.writeHead(302, { location: "http://127.0.0.1:9/redirect-is-not-followed" });
          res.end();
          return;
        }
        const current = (await state.read<StoredDatabaseOperation>("operations", operationId))!;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            operationId,
            status:
              current.public.status === "failed"
                ? "failed"
                : ["complete", "canceled"].includes(current.public.status)
                  ? "complete"
                  : "running",
          }),
        );
        return;
      }
      if (req.method === "POST" && context.url.pathname === "/api/system/database/host-recovery") {
        hostPosts++;
        await beforeHost?.();
        if (dropHost) {
          dropHost = false;
          res.end = (() => {
            res.destroy();
            return res;
          }) as ServerResponse["end"];
        }
      }
      if (req.method === "POST" && context.url.pathname.endsWith("/retry")) {
        retryPosts++;
        if (dropRetry) {
          dropRetry = false;
          res.end = (() => {
            res.destroy();
            return res;
          }) as ServerResponse["end"];
        }
      }
      if ((await recovery.handle(context)) || (await routes.handleCapability(context, operationId))) return;
      res.writeHead(404);
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing loopback fixture");
  const base = `http://127.0.0.1:${address.port}`;
  disposals.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const post = async (statusToken: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/api/system/database/host-recovery", {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        "X-Panda-Database-Host-Recovery": marker.secret,
        ...headers,
      },
      body: JSON.stringify({ statusToken }),
    });
    return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control") };
  };
  const saved = () => state.read<StoredDatabaseOperation>("operations", operationId).then((value) => value!);
  const change = async (patch: Partial<StoredDatabaseOperation["public"]>) => {
    const value = await saved();
    await state.write("operations", operationId, { ...value, public: { ...value.public, ...patch } });
  };
  return {
    root,
    state,
    operationId,
    oldToken,
    record,
    marker,
    service,
    recovery,
    base,
    post,
    saved,
    change,
    flags: {
      dropHost: () => {
        dropHost = true;
      },
      dropRetry: () => {
        dropRetry = true;
      },
      redirectPublic: () => {
        redirectPublic = true;
      },
      beforeHost: (callback: () => Promise<void>) => {
        beforeHost = callback;
      },
    },
    counts: () => ({ hostPosts, retryPosts }),
  };
}
async function command(f: Awaited<ReturnType<typeof fixture>>, output: string, extra: string[] = []) {
  const child = Bun.spawn(
    [
      process.execPath,
      "src/server/database/recover.ts",
      "--state-root",
      f.root,
      "--url",
      f.base,
      "--output",
      output,
      ...extra,
    ],
    {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
      },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
function noSecrets(result: { stdout: string; stderr: string }, secrets: string[]) {
  for (const secret of secrets) expect(result.stdout + result.stderr).not.toContain(secret);
}

test("host initialization preserves the same private secret and rotates it for a different pending operation", async () => {
  const f = await fixture(),
    path = join(f.state.root, "host-recovery.json");
  expect(f.marker.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  await initializeDatabaseHostRecovery({ state: f.state, operationId: f.operationId });
  expect(await f.state.read("", "host-recovery")).toEqual(f.marker);
  const operationId = randomUUID();
  await f.state.write("", "pending", { schema: 1, operationId });
  await initializeDatabaseHostRecovery({ state: f.state, operationId });
  const next = (await f.state.read<DatabaseHostRecoveryMarker>("", "host-recovery"))!;
  expect(next.operationId).toBe(operationId);
  expect(next.secret).not.toBe(f.marker.secret);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
});

test("host rotation changes only the capability fields, revokes the old token, and replays safely", async () => {
  const f = await fixture(),
    next = token(),
    response = await f.post(next);
  expect(response.status).toBe(200);
  expect(response.cache).toBe("no-store");
  expect(JSON.parse(response.text)).toEqual({ operationId: f.operationId, recovered: true });
  for (const secret of [next, f.marker.secret, f.oldToken, "statusTokenHash"])
    expect(response.text).not.toContain(secret);
  const saved = await f.saved();
  expect(saved).toEqual({ ...f.record, statusTokenHash: hash(next), tokenExpiresAt: saved.tokenExpiresAt });
  expect(saved.tokenExpiresAt).toBeGreaterThan(Date.now() + 6 * 86400000);
  await expect(f.service.operation(f.operationId, f.oldToken)).rejects.toMatchObject({ code: "operationTokenInvalid" });
  expect((await f.service.operation(f.operationId, next)).id).toBe(f.operationId);
  expect((await f.post(next)).status).toBe(200);
  expect(await f.saved()).toEqual(saved);
});

test("wrong host secret, missing or cross-site Origin and malformed capability cannot rotate", async () => {
  const f = await fixture();
  expect((await f.post(token(), { "X-Panda-Database-Host-Recovery": token() })).status).toBe(401);
  expect((await f.post(token(), { origin: "https://untrusted.invalid" })).status).toBe(403);
  expect((await f.post(token(), { origin: "" })).status).toBe(403);
  expect((await f.post(token(), { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await f.post("invalid")).status).toBe(400);
  expect(await f.saved()).toEqual(f.record);
});

test("malformed and non-object request bodies return a stable configuration error", async () => {
  const f = await fixture();
  for (const body of ["null", "[]", "{invalid", JSON.stringify({ statusToken: token(), unexpected: true })]) {
    const response = await fetch(f.base + "/api/system/database/host-recovery", {
      method: "POST",
      headers: {
        origin: f.base,
        "content-type": "application/json",
        "X-Panda-Database-Host-Recovery": f.marker.secret,
      },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalidDatabaseConfiguration" } });
  }
  expect(await f.saved()).toEqual(f.record);
});

test("running, terminal, non-retryable and no-longer-current operations reject host rotation", async () => {
  const f = await fixture();
  for (const status of ["waiting-restart", "running", "complete", "canceled"] as const) {
    await f.change({ status, canRetry: true });
    expect((await f.post(token())).status).toBe(409);
  }
  await f.change({ status: "failed", canRetry: false });
  expect((await f.post(token())).status).toBe(409);
  await f.change({ canRetry: true });
  await f.state.write("", "pending", { schema: 1, operationId: randomUUID() });
  expect((await f.post(token())).status).toBe(404);
  expect((await f.saved()).statusTokenHash).toBe(f.record.statusTokenHash);
});

test("host rotation reads the latest status after a concurrent retry owns the state queue", async () => {
  const f = await fixture();
  let release: () => void = () => {},
    arrived: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const lock = f.state.exclusive(async () => {
    await blocked;
    await f.change({ status: "running", stage: "copy", canRetry: false });
  });
  f.flags.beforeHost(async () => {
    arrived();
  });
  const rotating = f.post(token());
  await requestArrived;
  release();
  await lock;
  expect((await rotating).status).toBe(409);
  expect((await f.saved()).statusTokenHash).toBe(f.record.statusTokenHash);
});

test("the CLI saves a 0600 capability before POST, ignores proxies, and never prints secrets", async () => {
  const f = await fixture(),
    output = join(f.root, "recovery.json");
  let savedBeforePost = false;
  f.flags.beforeHost(async () => {
    const value = JSON.parse(await readFile(output, "utf8"));
    savedBeforePost =
      value.operationId === f.operationId &&
      /^[A-Za-z0-9_-]{43}$/.test(value.statusToken) &&
      ((await lstat(output)).mode & 0o777) === 0o600;
  });
  const result = await command(f, output);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(savedBeforePost).toBe(true);
  const saved = JSON.parse(await readFile(output, "utf8"));
  expect((await f.saved()).statusTokenHash).toBe(hash(saved.statusToken));
  noSecrets(result, [saved.statusToken, f.marker.secret, f.oldToken]);
  expect(f.counts()).toEqual({ hostPosts: 1, retryPosts: 0 });
});

test("a lost host-rotation response reuses the saved capability on the next command", async () => {
  const f = await fixture(),
    output = join(f.root, "recovery.json");
  f.flags.dropHost();
  const unknown = await command(f, output);
  expect(unknown.code).toBe(1);
  const saved = JSON.parse(await readFile(output, "utf8")),
    accepted = await f.saved();
  expect(accepted.statusTokenHash).toBe(hash(saved.statusToken));
  const replay = await command(f, output);
  expect(replay.code).toBe(0);
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual(saved);
  expect(await f.saved()).toEqual(accepted);
  await expect(f.service.operation(f.operationId, f.oldToken)).rejects.toMatchObject({ code: "operationTokenInvalid" });
  noSecrets(unknown, [saved.statusToken, f.marker.secret]);
  noSecrets(replay, [saved.statusToken, f.marker.secret]);
});

test("a lost retry response queries the same operation and never submits another rotation or retry", async () => {
  const f = await fixture(),
    output = join(f.root, "recovery.json");
  f.flags.dropRetry();
  const unknown = await command(f, output, ["--retry"]);
  expect(unknown.code).toBe(1);
  expect((await f.saved()).public.status).toBe("waiting-restart");
  const recovered = await command(f, output, ["--retry"]);
  expect(recovered.code).toBe(0);
  expect(f.counts()).toEqual({ hostPosts: 1, retryPosts: 1 });
  const saved = JSON.parse(await readFile(output, "utf8"));
  noSecrets(unknown, [saved.statusToken, f.marker.secret]);
  noSecrets(recovered, [saved.statusToken, f.marker.secret]);
});

test("unsafe private files and output symlinks fail without changing a capability", async () => {
  const f = await fixture(),
    output = join(f.root, "recovery.json"),
    markerPath = join(f.state.root, "host-recovery.json");
  await chmod(markerPath, 0o644);
  expect((await command(f, output)).code).toBe(1);
  expect(f.counts().hostPosts).toBe(0);
  await chmod(markerPath, 0o600);
  await writeFile(output, JSON.stringify({ operationId: f.operationId, statusToken: token() }), { mode: 0o644 });
  expect((await command(f, output)).code).toBe(1);
  expect(f.counts().hostPosts).toBe(0);
  await rm(output);
  const outside = join(f.root, "outside.json"),
    body = JSON.stringify({ operationId: f.operationId, statusToken: token() });
  await writeFile(outside, body, { mode: 0o600 });
  await symlink(outside, output);
  expect((await command(f, output)).code).toBe(1);
  expect(await readFile(outside, "utf8")).toBe(body);
  expect(f.counts().hostPosts).toBe(0);
  expect(await f.saved()).toEqual(f.record);
});

test("explicit loopback, matching public failed status and a stable output identity are required", async () => {
  const f = await fixture(),
    output = join(f.root, "recovery.json");
  for (const url of [
    "https://remote.invalid",
    "http://localhost:4000",
    "http://127.0.0.1:4000/path",
    "http://secret:password@127.0.0.1",
    "http://127.0.0.1/?secret=bad",
  ])
    await expect(recoverDatabaseOperation({ stateRoot: f.root, output, url, retry: false })).rejects.toMatchObject({
      code: "hostRecoveryArguments",
    });
  await f.change({ status: "running" });
  expect((await command(f, output)).code).toBe(1);
  expect(f.counts().hostPosts).toBe(0);
  await f.change({ status: "failed" });
  await writeFile(output, JSON.stringify({ operationId: randomUUID(), statusToken: token() }), { mode: 0o600 });
  expect((await command(f, output)).code).toBe(1);
  expect(f.counts().hostPosts).toBe(0);
  await rm(output);
  f.flags.redirectPublic();
  expect((await command(f, output)).code).toBe(1);
  expect(f.counts().hostPosts).toBe(0);
});

test("CLI recovery messages are available in all four regional locales", async () => {
  const f = await fixture(),
    expected: Record<string, string> = {
      en: "Recovery capability saved",
      "zh-CN": "恢复令牌已保存",
      "zh-HK": "恢復權杖已儲存",
      "zh-TW": "復原權杖已儲存",
    };
  for (const locale of Object.keys(expected)) {
    const output = join(f.root, locale + ".json"),
      result = await command(f, output, ["--locale", locale]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(expected[locale]!);
    const saved = JSON.parse(await readFile(output, "utf8"));
    noSecrets(result, [saved.statusToken, f.marker.secret]);
  }
});
