import { expect, test } from "bun:test";
import { XOAuthProvider } from "../../src/server/connections/adapters/x/oauth.js";
import { xTokens } from "../../src/server/connections/adapters/x/oauth-values.js";
import { OAuthHttp } from "../../src/server/connections/oauth/http.js";
import { createPkce, pkceChallenge } from "../../src/server/connections/oauth/pkce.js";
import type { OAuthJsonTransport } from "../../src/server/connections/oauth/ports.js";

const config = { clientId: "fixture-client", callbackUrl: "https://panda.example.com/api/connections/x/callback" };
const token = {
  token_type: "bearer",
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  expires_in: 7200,
  scope: "tweet.read users.read tweet.write offline.access media.write",
};
const fakeFetch = (fn: (url: string | URL | Request, options?: RequestInit) => Promise<Response>) => fn as typeof fetch;

test("X authorization uses independent PKCE state, exact callback and no client secret in the redirect", async () => {
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const pkce = createPkce(),
    next = createPkce();
  expect(new Set([pkce.state, next.state, pkce.verifier, next.verifier]).size).toBe(4);
  const requests: { url: string; init: RequestInit }[] = [];
  const transport: OAuthJsonTransport = {
    request: async (url, init) => {
      requests.push({ url, init });
      return token;
    },
  };
  const provider = new XOAuthProvider({ ...config, clientSecret: "fixture-secret" }, transport, () => 1000);
  const url = new URL(provider.authorize(pkce.state, pkce.challenge));
  expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
  expect(url.searchParams.get("state")).toBe(pkce.state);
  expect(url.href.includes("fixture-secret") || url.href.includes(pkce.verifier)).toBe(false);
  expect(requests).toHaveLength(0);
  const tokens = await provider.exchange("fixture-code", pkce.verifier);
  expect(tokens.expiresAt).toBe(7201000);
  expect(requests[0]!.url).toBe("https://api.x.com/2/oauth2/token");
  const headers = new Headers(requests[0]!.init.headers),
    body = requests[0]!.init.body as URLSearchParams;
  expect(headers.get("authorization")).toBe("Basic " + Buffer.from("fixture-client:fixture-secret").toString("base64"));
  expect(body.get("code_verifier")).toBe(pkce.verifier);
  expect(body.get("redirect_uri")).toBe(config.callbackUrl);
  expect(body.has("client_secret") || body.has("client_id")).toBe(false);
  expect(provider.configuration).not.toBe(
    new XOAuthProvider({ ...config, clientSecret: "replacement" }, transport).configuration,
  );
  expect(tokens).not.toHaveProperty("articleEntitlement");
});

test("public clients send client ID, refresh responses retain omitted refresh tokens, and identity uses the user endpoint", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const provider = new XOAuthProvider(
    config,
    {
      request: async (url, init) => {
        requests.push({ url, init });
        return url.endsWith("/users/me")
          ? { data: { id: "12345", username: "fixture_user", name: "Fixture User" } }
          : token;
      },
    },
    () => 1000,
  );
  const tokens = await provider.exchange("fixture-code", createPkce().verifier);
  expect(new Headers(requests[0]!.init.headers).has("authorization")).toBe(false);
  expect((requests[0]!.init.body as URLSearchParams).get("client_id")).toBe(config.clientId);
  await provider.refresh(tokens);
  expect((requests[1]!.init.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
  expect((requests[1]!.init.body as URLSearchParams).get("refresh_token")).toBe(tokens.refreshToken!);
  const { refresh_token: _refresh, ...withoutRefresh } = token;
  expect(xTokens(withoutRefresh, 2000, tokens).refreshToken).toBe(tokens.refreshToken!);
  expect(await provider.identity(tokens)).toEqual({ id: "12345", username: "fixture_user", name: "Fixture User" });
  expect(requests[2]!.url).toBe("https://api.x.com/2/users/me");
  expect(new Headers(requests[2]!.init.headers).get("authorization")).toBe("Bearer fixture-access");
  await expect(provider.identity({ ...tokens, expiresAt: 999 })).rejects.toThrow("authorizationRejected");
  expect(requests).toHaveLength(3);
});

test("unsafe callback configuration, malformed token responses and invalid account identities fail closed", async () => {
  const transport: OAuthJsonTransport = { request: async () => token };
  for (const callbackUrl of [
    "javascript:alert(1)",
    "http://example.com/callback",
    "https://user:pass@example.com/callback",
    "https://example.com/callback#fragment",
    "https://example.com/callback?q=1",
  ])
    expect(() => new XOAuthProvider({ ...config, callbackUrl }, transport)).toThrow("invalidOAuthConfig");
  expect(
    new XOAuthProvider({ ...config, callbackUrl: "http://localhost:8899/api/connections/x/callback" }, transport)
      .configuration,
  ).toHaveLength(64);
  for (const changed of [
    { token_type: "mac" },
    { access_token: "bad\nheader" },
    { expires_in: -1 },
    { expires_in: 1.5 },
    { scope: "" },
    { scope: "users.read admin" },
    { refresh_token: 123 },
  ])
    expect(() => xTokens({ ...token, ...changed }, 1000)).toThrow("invalidOAuthResponse");
  const tokens = xTokens(token, 1000);
  for (const data of [
    null,
    { id: 123, username: "user", name: "User" },
    { id: "123", username: "bad/name", name: "User" },
  ]) {
    const provider = new XOAuthProvider(config, { request: async () => ({ data }) }, () => 1001);
    await expect(provider.identity(tokens)).rejects.toThrow("invalidOAuthResponse");
  }
});

test("OAuth HTTP never retries writes, follows redirects, or exposes provider error bodies", async () => {
  for (const [status, expected] of [
    [400, "authorizationRejected"],
    [401, "authorizationRejected"],
    [403, "authorizationRejected"],
    [429, "authorizationRateLimited"],
    [500, "authorizationUnavailable"],
  ] as const) {
    let calls = 0;
    const http = new OAuthHttp(
      fakeFetch(async (_url, init) => {
        calls++;
        expect(init!.redirect).toBe("error");
        return new Response("private-response-fixture", { status });
      }),
    );
    await expect(http.request("https://api.x.com/2/oauth2/token", { method: "POST" })).rejects.toThrow(expected);
    expect(calls).toBe(1);
  }
  const http = new OAuthHttp(
    fakeFetch(async () => {
      throw new Error("private-token-fixture");
    }),
  );
  await expect(http.request("https://api.x.com/2/oauth2/token", { method: "POST" })).rejects.toThrow(
    "authorizationUnavailable",
  );
});

test("OAuth HTTP bounds response size and duration and rejects non-object JSON", async () => {
  for (const body of [JSON.stringify("x".repeat(65537)), "[1,2]", "invalid-json", "null"]) {
    const http = new OAuthHttp(
      fakeFetch(async () => new Response(body, { headers: { "Content-Type": "application/json" } })),
    );
    await expect(http.request("https://api.x.com/2/oauth2/token", {})).rejects.toThrow("invalidOAuthResponse");
  }
  const json = new OAuthHttp(fakeFetch(async () => Response.json({ data: "fixture" })));
  expect(await json.request("https://api.x.com/2/users/me", {})).toEqual({ data: "fixture" });
  let calls = 0;
  const stalled = new OAuthHttp(
    fakeFetch(async (_url, init) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true }),
      );
    }),
    10,
  );
  await expect(stalled.request("https://api.x.com/2/oauth2/token", { method: "POST" })).rejects.toThrow(
    "authorizationUnavailable",
  );
  expect(calls).toBe(1);
});
