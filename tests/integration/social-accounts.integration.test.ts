import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAppFixture } from "../support/app-fixture.mjs";

test("social account routes enforce authentication, callback origin, CSRF, owner identity and durable consent without contacting X", async () => {
  const app = await createAppFixture();
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const response = await fetch(app.base + path, {
      method,
      headers: { ...app.headers, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await fetch(app.base + "/api/publication-accounts?project=" + randomUUID())).status).toBe(401);
    expect((await call("/api/publication-accounts?project=" + randomUUID())).body.messageId).toBe(
      "connections.identityRequired",
    );
    expect((await call("/api/auth/setup", "POST", { username: "social-owner" })).status).toBe(200);
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", {
        code: "accounts",
        name: "Social accounts fixture",
        revision: catalog.revision,
      })
    ).body.projects[0];
    const input = {
      id: randomUUID(),
      projectId: project.id,
      name: "X test",
      provider: "x",
      application: {
        clientId: "fixture-client",
        clientSecret: "fixture-route-secret",
        callbackUrl: app.base + "/api/publication-accounts/x/callback",
      },
    };
    expect([401, 403]).toContain(
      (await call("/api/publication-accounts", "POST", input, { origin: "https://foreign.example" })).status,
    );
    expect((await call("/api/publication-accounts", "POST", { ...input, ownerId: "other" })).status).toBe(400);
    expect(
      (
        await call("/api/publication-accounts", "POST", {
          ...input,
          application: {
            ...input.application,
            callbackUrl: "https://foreign.example/api/publication-accounts/x/callback",
          },
        })
      ).body.messageId,
    ).toBe("accounts.invalidCallback");
    const created = await call("/api/publication-accounts", "POST", input);
    expect(created.status).toBe(201);
    expect(JSON.stringify(created)).not.toContain(input.application.clientSecret);
    expect((await call("/api/publication-accounts", "POST", input)).body).toEqual(created.body);
    const start = await call("/api/publication-accounts/authorize", "POST", { id: input.id, version: 1 });
    expect(start.status).toBe(201);
    const url = new URL(start.body.authorization.url);
    expect(url.origin).toBe("https://x.com");
    expect(url.searchParams.get("redirect_uri")).toBe(input.application.callbackUrl);
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!,
      attempt = start.body.authorization.id;
    await app.stop();
    await app.start();
    expect((await call("/api/publication-accounts/detail?id=" + input.id)).body).toEqual(created.body);
    expect((await call("/api/publication-accounts/authorization?id=" + attempt)).body.authorization.phase).toBe(
      "prepared",
    );
    const handoff = await fetch(
      input.application.callbackUrl + "?state=fixture-sensitive-state&code=fixture-sensitive-code",
      { headers: { "sec-fetch-site": "cross-site" } },
    );
    expect(handoff.status).toBe(200);
    const handoffHtml = await handoff.text();
    expect(handoffHtml).not.toContain("fixture-sensitive-state");
    expect(handoffHtml).not.toContain("fixture-sensitive-code");
    expect(handoffHtml).toContain("history.replaceState");
    expect(handoff.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const completion = { state, code: "", denied: true };
    expect(
      (
        await fetch(app.base + "/api/publication-accounts/x/complete", {
          method: "POST",
          body: JSON.stringify(completion),
        })
      ).status,
    ).toBe(401);
    expect([401, 403]).toContain(
      (await call("/api/publication-accounts/x/complete", "POST", completion, { origin: "https://foreign.example" }))
        .status,
    );
    const callback = await call("/api/publication-accounts/x/complete", "POST", completion);
    expect(callback.status).toBe(200);
    expect(callback.body.redirect).toBe("/api/publication-accounts/authorization-result?id=" + attempt);
    expect((await call("/api/publication-accounts/authorization?id=" + attempt)).body.authorization.phase).toBe(
      "failed",
    );
    const page = await fetch(app.base + callback.body.redirect, {
        headers: { ...app.headers, "accept-language": "zh-CN" },
      }),
      html = await page.text();
    expect(html).toContain("授权未完成");
    expect(html).toContain("/documents?project=" + project.id);
    expect(html).not.toContain(state);
    expect(html).not.toContain("fixture-secret-provider-description");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    const invalid = await call("/api/publication-accounts/x/complete", "POST", {
      state: "invalid",
      code: "fixture-sensitive-code",
      denied: false,
    });
    expect(invalid.body.redirect).toBe("/api/publication-accounts/authorization-result");
    expect(
      (
        await call("/api/publication-accounts/detail?id=" + input.id, "PUT", {
          version: 1,
          name: "Renamed",
          enabled: true,
        })
      ).body.account.version,
    ).toBe(2);
    expect(
      (await call("/api/publication-accounts/authorize", "POST", { id: input.id, version: 1 })).body.messageId,
    ).toBe("connections.conflict");
    expect(
      (await call("/api/publication-accounts/disconnect", "POST", { id: input.id, version: 2 })).body.account.enabled,
    ).toBe(false);
    expect(
      (await call("/api/publication-accounts/authorize", "POST", { id: input.id, version: 3 })).body.messageId,
    ).toBe("accounts.authorizationRejected");
    expect((await call("/api/publication-accounts?project=" + project.id)).body.accounts).toHaveLength(1);
    expect((await call("/api/publication-connections?project=" + project.id)).body.connections).toHaveLength(0);
  } finally {
    await app.dispose();
  }
}, 30000);
