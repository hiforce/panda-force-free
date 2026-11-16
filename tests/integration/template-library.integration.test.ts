import { expect, test } from "bun:test";
import { createAppFixture } from "../support/app-fixture.mjs";
import { exampleTemplateDefinition } from "../support/template-definition.mjs";

test("template maintenance authenticates, pins reviewed baselines, archives atomically and survives restart without channel access", async () => {
  const app = await createAppFixture(),
    cookies = new Map<string, string>();
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", origin?: string) => {
    const response = await fetch(app.base + path, {
      method,
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
  };
  try {
    expect((await call("/api/template-library")).status).toBe(401);
    expect((await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" })).status).toBe(
      200,
    );
    expect((await call("/api/template-library")).status).toBe(403);
    await call("/api/auth/setup", { username: "fixture-owner" });
    const definition = exampleTemplateDefinition();
    expect([401, 403]).toContain(
      (await call("/api/template-library", definition, "POST", "https://another.example")).status,
    );
    expect((await call("/api/template-library")).body.drafts).toEqual([]);
    const created = await call("/api/template-library", definition);
    expect(created.status).toBe(201);
    let draft = created.body.draft;
    expect(draft.updatedBy).toMatch(/^[a-f0-9]{64}$/);
    const preview = await call("/api/template-library/preview", { id: draft.id, fixtureId: "core" });
    expect(preview.status).toBe(200);
    expect(preview.body.state).toBe("unreviewed");
    expect(preview.body.html).toContain("blockquote");
    expect(
      (
        await call("/api/template-library/baseline", {
          id: draft.id,
          revision: draft.revision,
          fixtureId: "core",
          digest: "0".repeat(64),
        })
      ).status,
    ).toBe(409);
    draft = (
      await call("/api/template-library/baseline", {
        id: draft.id,
        revision: draft.revision,
        fixtureId: "core",
        digest: preview.body.actualDigest,
      })
    ).body.draft;
    draft = (await call("/api/template-library/validate", { id: draft.id, revision: draft.revision })).body.draft;
    expect(draft.validation.passed).toBe(true);
    const review = (await call("/api/document-packages/review", draft.definition.package)).body;
    const payload = {
      id: draft.id,
      revision: draft.revision,
      digest: draft.digest,
      approval: { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
    };
    expect((await call("/api/template-library/publish", { ...payload, actor: "forged" })).status).toBe(400);
    expect(
      (await call("/api/template-library/publish", { ...payload, approval: { ...payload.approval, permissions: [] } }))
        .status,
    ).toBe(403);
    const published = await call("/api/template-library/publish", payload);
    expect(published.status).toBe(201);
    expect(published.body.release.publishedBy).toBe(draft.updatedBy);
    expect((await call("/api/document-packages")).body.packages).toHaveLength(1);
    const state = await call("/api/template-library");
    expect(state.body.releases).toHaveLength(1);
    expect(state.body.releases[0]).not.toHaveProperty("definition");
    expect(JSON.stringify(state.body)).not.toContain("const safe = true;");
    expect((await call("/api/template-library/publish", payload)).body.release).toEqual(published.body.release);
    expect(
      (await call("/api/template-library/draft?id=" + draft.id, { definition, revision: draft.revision + 1 }, "PUT"))
        .status,
    ).toBe(409);
    await app.stop();
    await app.start();
    expect((await call("/api/template-library/release?id=example.editorial&version=1.0.0")).body.release).toEqual(
      published.body.release,
    );
    const fork = await call("/api/template-library/fork", {
      id: "example.editorial",
      fromVersion: "1.0.0",
      version: "1.0.1",
    });
    expect(fork.status).toBe(201);
    expect(fork.body.draft.validation).toBe(null);
    const removed = await call(
      "/api/template-library/draft?id=" + draft.id,
      { revision: draft.revision + 1 },
      "DELETE",
    );
    expect(removed.status).toBe(200);
    expect((await call("/api/template-library/release?id=example.editorial&version=1.0.0")).body.release).toEqual(
      published.body.release,
    );
  } finally {
    await app.dispose();
  }
}, 30000);
