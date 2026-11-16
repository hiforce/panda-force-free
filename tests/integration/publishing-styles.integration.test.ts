import { expect, test } from "bun:test";
import { createAppFixture } from "../support/app-fixture.mjs";
import { exampleTemplateDefinition } from "../support/template-definition.mjs";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";

test("style samples and exports authenticate, use exact catalog versions and remain read-only across restart", async () => {
  const app = await createAppFixture();
  const cookies = new Map<string, string>();
  async function call(path: string, body?: unknown, origin?: string) {
    const response = await fetch(app.base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: [...cookies.values()].join("; "),
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return { status: response.status, body: await response.json() };
  }
  const sample = { id: "technical", version: "1", format: "html" };
  try {
    expect((await call("/api/publishing-styles/sample", sample)).status).toBe(401);
    expect((await call("/api/document-packages/export?id=example.editorial&version=1.0.0")).status).toBe(401);
    await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    expect((await call("/api/publishing-styles/sample", sample)).status).toBe(403);
    await call("/api/auth/setup", { username: "fixture-owner" });
    expect([401, 403]).toContain((await call("/api/publishing-styles/sample", sample, "https://other.example")).status);
    const definition = exampleTemplateDefinition();
    const review = (await call("/api/document-packages/review", definition.package)).body;
    expect(
      (
        await call("/api/document-packages/install", {
          package: definition.package,
          approval: { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
        })
      ).status,
    ).toBe(201);
    const before = (await call("/api/document-packages")).body;
    const projects = (await call("/api/projects")).body;
    const library = (await call("/api/template-library")).body;
    const result = await call("/api/publishing-styles/sample", sample);
    expect(result.status).toBe(200);
    expect(result.body.html).toContain("A place for clear ideas");
    expect(result.body.html).toContain("#2863a7");
    expect(result.body.actualDigest).toMatch(/^[a-f0-9]{64}$/);
    const post = await call("/api/publishing-styles/sample", { ...sample, format: "x-post" });
    expect(post.status).toBe(200);
    expect(post.body.posts.length).toBeGreaterThan(0);
    expect(post.body.posts.map((entry: { text: string }) => entry.text).join("\n")).not.toMatch(
      /<article|font-family|#2863a7/,
    );
    const installed = { id: "example.editorial.paper", version: "1.0.0", format: "html" };
    const custom = await call("/api/publishing-styles/sample", installed);
    expect(custom.status).toBe(200);
    expect(custom.body.html).toContain("#884422");
    for (const invalid of [
      { ...sample, version: "9" },
      { ...sample, id: "missing" },
      { ...installed, format: "x-post" },
      { ...sample, format: "html; curl secret" },
      { ...sample, content: "Private input must be rejected" },
    ])
      expect((await call("/api/publishing-styles/sample", invalid)).status).toBe(400);
    const exported = await call("/api/document-packages/export?id=example.editorial&version=1.0.0");
    expect(exported.status).toBe(200);
    expect(exported.body).toEqual((await verifyPluginPackage(definition.package)).package);
    expect((await verifyPluginPackage(exported.body)).digest).toBe(review.digest);
    expect((await call("/api/document-packages")).body).toEqual(before);
    expect((await call("/api/projects")).body).toEqual(projects);
    expect((await call("/api/template-library")).body).toEqual(library);
    await app.stop();
    await app.start();
    expect((await call("/api/publishing-styles/sample", sample)).body).toEqual(result.body);
    expect((await call("/api/document-packages/export?id=example.editorial&version=1.0.0")).body).toEqual(
      exported.body,
    );
  } finally {
    await app.dispose();
  }
}, 30000);
