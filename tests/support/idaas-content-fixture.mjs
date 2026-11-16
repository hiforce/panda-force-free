import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { createAppFixture } from "./app-fixture.mjs";

export const contentFixtureOwner = (account) =>
  createHash("sha256")
    .update(JSON.stringify(["idaas", "42", "fixture-" + account]))
    .digest("hex");
/** Real HTTP login and production composition, backed exclusively by a disposable local identity provider and fake engine. */
export async function idaasContentFixture() {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/oidc/token") {
        const body = await req.json();
        if (!["admin", "alice", "bob"].includes(body.code))
          return new Response("Invalid fixture account", { status: 401 });
        return Response.json({
          success: true,
          data: { access_token: "fixture-" + body.code, id_token: "fixture-id", expires_in: 3600 },
        });
      }
      if (path === "/oidc/token/introspection")
        return Response.json({ active: true, exp: Math.floor(Date.now() / 1000) + 3600 });
      if (path === "/oidc/me") {
        const account = (req.headers.get("authorization") ?? "").replace("Bearer fixture-", "");
        if (!["admin", "alice", "bob"].includes(account)) return new Response("Invalid fixture token", { status: 401 });
        return Response.json({ success: true, data: { uuid: "fixture-" + account, tenantId: 42, account } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  let app;
  try {
    app = await createAppFixture({
      freshAdministrator: true,
      applicationKnowledge: true,
      extraEnvironment: ({ dir, base }) => {
        const policy = join(dir, "content-access.json"),
          search = join(dir, "search-access.json");
        if (!existsSync(policy))
          writeFileSync(
            policy,
            JSON.stringify({ schema: 1, mode: "restricted", administrators: [contentFixtureOwner("admin")] }),
          );
        if (!existsSync(search))
          writeFileSync(
            search,
            JSON.stringify({
              schema: 1,
              connections: [],
              knowledge: [],
              administrators: [contentFixtureOwner("admin")],
            }),
          );
        return {
          PANDA_FORCE_AUTH_MODE: "idaas",
          IDAAS_AUTH_ENDPOINT: upstream.url.origin,
          IDAAS_BROWSER_ENDPOINT: upstream.url.origin,
          IDAAS_CLIENT_ID: "fixture",
          IDAAS_CLIENT_SECRET: "fixture-only",
          PANDA_FORCE_PUBLIC_URL: base,
          IDAAS_ALLOWED_TENANT_IDS: "42",
          IDAAS_ALLOWED_ACCOUNTS: "admin,alice,bob",
          PANDA_FORCE_CONTENT_ACCESS_CONFIG_FILE: policy,
          PANDA_FORCE_SEARCH_CONFIG_FILE: search,
        };
      },
    });
    const current = app;
    return {
      ...app,
      async login(account) {
        const login = await fetch(current.base + "/auth/login", { redirect: "manual" }),
          state = new URL(login.headers.get("location")).searchParams.get("state"),
          binding = login.headers.getSetCookie()[0].split(";")[0],
          callback = await fetch(current.base + "/auth/callback?" + new URLSearchParams({ code: account, state }), {
            redirect: "manual",
            headers: { cookie: binding, "sec-fetch-site": "cross-site" },
          });
        if (callback.status !== 303) throw new Error("Fixture OIDC callback failed: " + callback.status);
        const cookie = callback.headers.getSetCookie().find((value) => value.startsWith("panda_force_idaas_session="));
        if (!cookie) throw new Error("Fixture OIDC session missing");
        return cookie.split(";")[0];
      },
      api(cookie, path, body, method = body === undefined ? "GET" : "POST") {
        return fetch(current.base + path, {
          method,
          headers: {
            cookie,
            origin: current.base,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      },
      async close() {
        await current.dispose();
        upstream.stop(true);
      },
    };
  } catch (error) {
    await app?.dispose();
    upstream.stop(true);
    throw error;
  }
}
