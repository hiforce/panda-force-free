import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { GrokAccountCredentials, renewGrokAccount } from "../../src/server/harness/auth/grok-account.js";
import { serveCredentialBroker } from "../../src/server/harness/auth/broker.js";
import { brokerCredentialSource, credentialLease } from "../../src/server/harness/auth/remote.js";
import { accessCredentials, grokCredentialSnapshot } from "../../src/server/harness/auth/snapshot.js";
import { HarnessError } from "../../src/shared/harness/contracts.js";
import { GrokHarnessAgent } from "../../src/server/harness/adapters/grok.js";
import type { HarnessCredentialSnapshot } from "../../src/server/harness/auth/contracts.js";
import { harnessProfiles } from "../../src/server/harness/profiles.js";
import type { EngineDriver } from "../../src/shared/engine/contracts.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pf-auth-test-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const now = 1800000000000;
const account = (key = "expired-access", expires = now - 1000, user = "user-one") => ({
  "https://issuer.test::client": {
    key,
    refresh_token: "owner-refresh-only",
    expires_at: new Date(expires).toISOString(),
    user_id: user,
    team_id: "team",
    auth_mode: "oidc",
    metadata: { refreshToken: "nested-refresh-only" },
  },
});
async function fixture() {
  const home = await directory();
  const path = join(home, "auth.json");
  const put = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await put(account());
  return { home, path, put };
}

test("concurrent expired credentials renew once and only access credentials cross the Unix broker", async () => {
  const f = await fixture();
  let renewals = 0;
  const source = new GrokAccountCredentials({
    accountHome: f.home,
    now: () => now,
    renew: async () => {
      renewals++;
      await Bun.sleep(25);
      await f.put(account("fresh-access", now + 3600000));
    },
  });
  const socket = join(f.home, "broker.sock"),
    broker = await serveCredentialBroker(socket, source);
  cleanups.push(() => broker.close());
  const remote = brokerCredentialSource(socket);
  const values = await Promise.all(Array.from({ length: 16 }, () => remote.snapshot()));
  expect(renewals).toBe(1);
  expect(values.every((value) => value.generation === values[0]!.generation)).toBe(true);
  expect(JSON.stringify(values)).not.toContain("refresh");
  expect(JSON.stringify(values)).toContain("fresh-access");
  expect(await readFile(f.path, "utf8")).toContain("owner-refresh-only");
  expect((await stat(socket)).mode & 0o777).toBe(0o600);
});

test("fresh credentials skip native renewal and externally rotated files are reread", async () => {
  const f = await fixture();
  await f.put(account("fresh-access", now + 3600000));
  let renewals = 0;
  const source = new GrokAccountCredentials({
    accountHome: f.home,
    now: () => now,
    renew: async () => {
      renewals++;
    },
  });
  const first = await source.snapshot();
  await f.put(account("external-rotation", now + 7200000));
  const next = await source.snapshot(first.generation);
  expect(renewals).toBe(0);
  expect(next.generation).not.toBe(first.generation);
});

test("a durably rotated access token survives a subsequent native model-catalog timeout", async () => {
  const f = await fixture();
  const source = new GrokAccountCredentials({
    accountHome: f.home,
    now: () => now,
    renew: async () => {
      await f.put(account("rotated-before-timeout", now + 3600000));
      throw new HarnessError("timeout", 504);
    },
  });
  expect(JSON.stringify(await source.snapshot())).toContain("rotated-before-timeout");
});

test("revoked refresh grants return a safe login error and repeated calls respect cooldown", async () => {
  const f = await fixture();
  let renewals = 0;
  const source = new GrokAccountCredentials({
    accountHome: f.home,
    now: () => now,
    renew: async () => {
      renewals++;
      throw new HarnessError("authentication", 503);
    },
  });
  for (let i = 0; i < 3; i++)
    await expect(source.snapshot()).rejects.toMatchObject({ code: "authentication", message: "authentication" });
  expect(renewals).toBe(1);
});

test("network failures remain unavailable and an early-buffer access token can still be used", async () => {
  const f = await fixture();
  const source = new GrokAccountCredentials({
    accountHome: f.home,
    now: () => now,
    renew: async () => {
      throw Error("secret-native-prose");
    },
  });
  await expect(source.snapshot()).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
  await f.put(account("buffer-access", now + 120000));
  const buffered = await source.snapshot();
  expect(buffered.expiresAt).toBe(now + 120000);
});

test("missing refresh credentials, ambiguous identities, unsafe account files and switched accounts fail closed", async () => {
  const f = await fixture();
  let renewals = 0;
  const source = new GrokAccountCredentials({
    accountHome: f.home,
    now: () => now,
    renew: async () => {
      renewals++;
      await f.put(account("other-access", now + 3600000, "other-user"));
    },
  });
  const noRefresh = accessCredentials(account());
  await f.put(noRefresh);
  await expect(source.snapshot()).rejects.toMatchObject({ code: "authentication" });
  expect(renewals).toBe(0);
  await f.put({ ...account(), other: Object.values(account())[0] });
  await expect(source.snapshot()).rejects.toMatchObject({ code: "authentication" });
  await f.put(account());
  await expect(source.snapshot()).rejects.toMatchObject({ code: "authentication" });
  const other = await directory();
  await symlink(f.path, join(other, "auth.json"));
  await expect(
    new GrokAccountCredentials({ accountHome: other, renew: async () => {} }).snapshot(),
  ).rejects.toMatchObject({ code: "authentication" });
});

test("broker rejects arbitrary paths and malformed requests without invoking the credential source", async () => {
  const f = await fixture();
  let reads = 0;
  const socket = join(f.home, "broker.sock"),
    broker = await serveCredentialBroker(socket, {
      snapshot: async () => {
        reads++;
        return grokCredentialSnapshot(account());
      },
    });
  cleanups.push(() => broker.close());
  const post = (body: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: socket, path: "/v1/credentials", method: "POST" }, (res) => {
        let output = "";
        res.on("data", (chunk) => (output += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: output }));
      });
      req.on("error", reject);
      req.end(body);
    });
  expect((await post('{"accountHome":"/another-account"}')).status).toBe(400);
  expect((await post('"secret-native-prose"')).body).toBe('{"error":"invalidInput"}');
  expect((await post('{"rejectedGeneration":"bad"}')).status).toBe(400);
  expect(reads).toBe(0);
});

test("remote rejects snapshots containing refresh grants or inconsistent identity metadata", async () => {
  const f = await fixture();
  const socket = join(f.home, "invalid.sock");
  const server = createServer((_req, res) =>
    res.end(JSON.stringify({ ...grokCredentialSnapshot(account()), credentials: account() })),
  );
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(brokerCredentialSource(socket).snapshot()).rejects.toMatchObject({ code: "invalidProtocol" });
});

test("active leases install rotated access snapshots and stop all writes on cleanup", async () => {
  let current = grokCredentialSnapshot(account("first", now + 100)),
    reads = 0;
  const installed: HarnessCredentialSnapshot[] = [];
  const lease = await credentialLease(
    {
      snapshot: async () => {
        reads++;
        return current;
      },
    },
    async (value) => {
      installed.push(value);
    },
    { now: () => now, refreshBufferMs: 1000, minDelayMs: 10 },
  );
  cleanups.push(() => lease.close());
  current = grokCredentialSnapshot(account("second", now + 3600000));
  for (let i = 0; i < 100 && installed.length < 2; i++) await Bun.sleep(5);
  expect(installed[1]?.generation).toBe(current.generation);
  expect(JSON.stringify(installed)).not.toContain("refresh");
  await lease.close();
  const stopped = reads;
  await Bun.sleep(35);
  expect(reads).toBe(stopped);
});

test("credential leases reject account changes and closed leases cannot resume", async () => {
  let current = grokCredentialSnapshot(account("first", now + 3600000));
  const lease = await credentialLease({ snapshot: async () => current }, async () => {});
  current = grokCredentialSnapshot(account("other", now + 3600000, "other-user"));
  await expect(lease.prepare()).rejects.toMatchObject({ code: "authentication" });
  await lease.close();
  await expect(lease.prepare()).rejects.toMatchObject({ code: "unavailable" });
});

test("native refresh lists models without a prompt and excludes unrelated environment secrets", async () => {
  const f = await fixture(),
    command = join(f.home, "native-fixture");
  await writeFile(
    command,
    `#!/usr/bin/env bun\nimport{writeFileSync}from'node:fs';if(process.argv.at(-1)!=='models'||process.env.XAI_API_KEY||process.env.SMTP_PASSWORD)process.exit(9);writeFileSync(process.env.GROK_HOME+'/native-args.json',JSON.stringify(process.argv.slice(2)));`,
    { mode: 0o700 },
  );
  await renewGrokAccount({
    command,
    accountHome: f.home,
    env: { PATH: process.env.PATH, XAI_API_KEY: "fixture-only", SMTP_PASSWORD: "fixture-only" },
  });
  const args = JSON.parse(await readFile(join(f.home, "native-args.json"), "utf8"));
  expect(args).toContain("--no-auto-update");
  expect(args.at(-1)).toBe("models");
  expect(args).not.toContain("-p");
});

test("native refresh is bounded and native credential diagnostics never escape", async () => {
  const f = await fixture(),
    command = join(f.home, "native-fixture");
  await writeFile(
    command,
    '#!/usr/bin/env bun\nconsole.error("refresh_token invalid: secret-value");process.exit(1);',
    { mode: 0o700 },
  );
  await expect(renewGrokAccount({ command, accountHome: f.home })).rejects.toMatchObject({
    code: "authentication",
    message: "authentication",
  });
  await writeFile(command, "#!/usr/bin/env bun\nsetInterval(()=>{},1000);", { mode: 0o700 });
  await expect(renewGrokAccount({ command, accountHome: f.home, timeoutMs: 100 })).rejects.toMatchObject({
    code: "timeout",
  });
});

test("ACP retries authentication once before session creation and never replays a rejected prompt", async () => {
  const home = await directory();
  await mkdir(join(home, "sessions"));
  await writeFile(join(home, "auth.json"), JSON.stringify({ fixture: { rejectSession: true } }));
  let recoveries = 0;
  const agent = new GrokHarnessAgent({
    command: join(import.meta.dir, "../support/grok-acp-fixture.mjs"),
    args: [],
    cwd: home,
    env: { PATH: process.env.PATH, GROK_HOME: home },
    credentials: {
      prepare: async () => {},
      rejected: async () => {
        recoveries++;
        await writeFile(join(home, "auth.json"), JSON.stringify({ fixture: { rejectSession: false } }));
      },
    },
  });
  cleanups.push(() => agent.close());
  const session = await agent.create(home);
  expect(recoveries).toBe(1);
  expect(session.id).toBeTruthy();
  // The fixture fails before output on this prompt; auth recovery must not be entered after dispatch.
  await writeFile(join(home, "auth.json"), JSON.stringify({ fixture: { rejectPrompt: true } }));
  await expect(
    agent.prompt(
      session,
      { text: "auth-failure", model: null, effort: null, attachments: [], operationId: "fixture" },
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "authentication" });
  expect(recoveries).toBe(1);
  expect(await readFile(join(home, "rejected-prompts.txt"), "utf8")).toBe("1");
});

test("managed profiles authenticate without mounting the owner account and pin the native session identity", async () => {
  const f = await fixture();
  await f.put(account("fresh", now + 3600000));
  const socket = join(f.home, "broker.sock");
  const broker = await serveCredentialBroker(
    socket,
    new GrokAccountCredentials({ accountHome: f.home, now: () => now, renew: async () => {} }),
  );
  cleanups.push(() => broker.close());
  const state = await directory(),
    metadata = new SQLiteHarnessMetadata(join(state, "metadata.sqlite"));
  cleanups.push(async () => metadata.close());
  const registry = new HarnessRegistry(
    metadata,
    harnessProfiles(state, {} as EngineDriver, {
      PANDA_FORCE_GROK_COMMAND: join(import.meta.dir, "../support/grok-acp-fixture.mjs"),
      PANDA_FORCE_GROK_HOME: "/not-mounted-account",
      PANDA_FORCE_GROK_AUTH_SOCKET: socket,
      PATH: process.env.PATH,
    }),
  );
  await registry.initialize();
  const principal = { owner: "managed-admin", administrator: true };
  const first = await registry.agent(principal, "grok-build", "same-conversation", state);
  await first.agent.create(state);
  await first.agent.close();
  await f.put(account("another-account", now + 3600000, "other-user"));
  await expect(registry.agent(principal, "grok-build", "same-conversation", state)).rejects.toMatchObject({
    code: "authentication",
  });
});
