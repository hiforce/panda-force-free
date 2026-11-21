import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokAccountCredentials, renewGrokAccount } from "../../src/server/harness/auth/grok-account.js";

const command = process.env.PANDA_FORCE_GROK_NATIVE_COMMAND;
const nativeTest = command ? test : test.skip;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(revoke = false) {
  const home = await mkdtemp(join(tmpdir(), "pf-native-auth-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  let tokenCalls = 0;
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: server.url.origin,
          token_endpoint: server.url.origin + "/token",
          authorization_endpoint: server.url.origin + "/authorize",
          jwks_uri: server.url.origin + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      if (url.pathname === "/token") {
        tokenCalls++;
        const form = await req.formData();
        if (revoke || form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== "fixture-refresh")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: "fixture-native-renewed",
          refresh_token: "fixture-native-rotated",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return Response.json({ error: "fixture-not-found" }, { status: 404 });
    },
  });
  cleanups.push(async () => server.stop(true));
  const issuer = server.url.origin,
    scope = issuer + "::fixture-client";
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      [scope]: {
        key: "fixture-expired",
        auth_mode: "oidc",
        create_time: new Date().toISOString(),
        user_id: "fixture-user",
        team_id: "fixture-team",
        refresh_token: "fixture-refresh",
        expires_at: new Date(Date.now() - 60000).toISOString(),
        oidc_issuer: issuer,
        oidc_client_id: "fixture-client",
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(home, "config.toml"),
    "[cli]\nauto_update = false\nuse_leader = false\n[grok_com_config.oidc]\nissuer = " +
      JSON.stringify(issuer) +
      '\nclient_id = "fixture-client"\n',
  );
  const source = new GrokAccountCredentials({
    accountHome: home,
    renew: () =>
      renewGrokAccount({
        command: command!,
        accountHome: home,
        env: { PATH: process.env.PATH, HOME: home },
        timeoutMs: 10000,
      }),
  });
  return { source, requests, home, calls: () => tokenCalls };
}

nativeTest(
  "installed Grok performs one real native OAuth rotation for concurrent expired snapshots without prompts",
  async () => {
    const f = await fixture();
    const values = await Promise.all(Array.from({ length: 12 }, () => f.source.snapshot()));
    expect(f.calls()).toBe(1);
    expect(f.requests.every((path) => path === "/token" || path === "/.well-known/openid-configuration")).toBe(true);
    expect(values.every((value) => value.expiresAt !== null && value.expiresAt > Date.now() + 3000000)).toBe(true);
    expect(JSON.stringify(values)).toContain("fixture-native-renewed");
    expect(JSON.stringify(values)).not.toContain("fixture-native-rotated");
    expect(await readFile(join(f.home, "auth.json"), "utf8")).toContain("fixture-native-rotated");
  },
  20000,
);

nativeTest(
  "installed Grok rejects a revoked fixture refresh grant without opening a device login",
  async () => {
    const f = await fixture(true);
    await expect(f.source.snapshot()).rejects.toMatchObject({ code: "authentication" });
    expect(f.calls()).toBeGreaterThan(0);
    expect(f.requests).not.toContain("/authorize");
    expect(await readFile(join(f.home, "auth.json"), "utf8")).not.toContain("fixture-native-renewed");
  },
  20000,
);
