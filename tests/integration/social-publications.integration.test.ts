import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAppFixture } from "../support/app-fixture.mjs";

test("social publishing HTTP uses authenticated reviewed sources and refuses unconfirmed or unauthorized publication", async () => {
  const app = await createAppFixture();
  const request = (path: string, options: RequestInit = {}) =>
    fetch(app.base + path, { ...options, signal: AbortSignal.timeout(2000) });
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(app.legacyProject(body), { status: 201 })
        : await request(path, {
            method,
            headers: { ...app.headers, "content-type": "application/json", ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect((await request("/api/social-publications?space=" + randomUUID())).status).toBe(401);
    expect((await call("/api/auth/setup", "POST", { username: "publisher" })).status).toBe(200);
    const catalog = (await call("/api/projects")).body;
    const project = (
      await call("/api/projects", "POST", { code: "social", name: "Social fixture", revision: catalog.revision })
    ).body.projects[0];
    const space = (
      await call("/api/document-spaces", "POST", {
        projectId: project.id,
        code: "writing",
        name: "Writing",
        engine: "markdown",
        sourceMode: "managed",
        locale: "en",
      })
    ).body.space;
    const doc = (
      await call("/api/documents", "POST", {
        spaceId: space.id,
        path: "story.md",
        title: "Fixture",
        locale: "en",
        content: "Reviewed text.",
      })
    ).body;
    const variant = (
      await call("/api/publication-variants", "POST", {
        documentId: doc.document.id,
        revisionId: doc.revision.id,
        format: "x-post",
        mode: "format",
        templateId: "minimal",
      })
    ).body;
    expect((await call("/api/social-publications/context?variant=" + variant.variant.id)).body.messageId).toBe(
      "social.reviewRequired",
    );
    expect(
      (
        await call("/api/publication-variants/review", "POST", {
          id: variant.variant.id,
          digest: variant.digest,
          acceptedIssues: [],
        })
      ).status,
    ).toBe(200);
    expect((await call("/api/social-publications/context?variant=" + variant.variant.id)).body).toEqual({
      projectId: project.id,
      spaceId: space.id,
    });
    expect((await call("/api/social-publications?space=" + space.id)).body.publications).toEqual([]);
    const connectionId = randomUUID();
    expect(
      (
        await call("/api/publication-accounts", "POST", {
          id: connectionId,
          projectId: project.id,
          name: "Unconsented test account",
          provider: "x",
          application: { clientId: "fixture", callbackUrl: app.base + "/api/publication-accounts/x/callback" },
        })
      ).status,
    ).toBe(201);
    const prepare = { id: randomUUID(), variantId: variant.variant.id, connectionId };
    expect([401, 403]).toContain(
      (await call("/api/social-publications", "POST", prepare, { origin: "https://other.example" })).status,
    );
    const denied = await call("/api/social-publications", "POST", prepare);
    expect(denied.status).toBe(409);
    expect(denied.body.messageId).toBe("social.authorizationRequired");
    expect((await call("/api/social-publications", "POST", { ...prepare, text: "unreviewed content" })).status).toBe(
      400,
    );
    expect(
      (
        await call("/api/social-publications/submit", "POST", {
          id: prepare.id,
          kind: "x-post",
          fingerprint: "a".repeat(64),
        })
      ).body.messageId,
    ).toBe("social.publicationConfirmationRequired");
    expect(
      (await call("/api/social-publications/article-publish", "POST", { id: randomUUID(), draftId: randomUUID() }))
        .status,
    ).toBe(404);
    for (const action of ["inspect", "adopt"]) {
      const path = `/api/social-publications/recovery/${action}`;
      expect((await request(path, { method: "POST", body: "{}" })).status).toBe(401);
      expect([401, 403]).toContain((await call(path, "POST", {}, { origin: "https://other.example" })).status);
      expect((await call(path, "POST", {})).status).toBe(400);
      const input = {
        id: randomUUID(),
        kind: "x-post",
        fingerprint: "a".repeat(64),
        ...(action === "inspect"
          ? { stepId: 1, remoteId: "123", acceptLookupCosts: true }
          : { evidenceId: randomUUID(), acceptExistingResult: true }),
      };
      expect((await call(path, "POST", input)).status).toBe(404);
    }
    const successorPath = "/api/social-publications/successor";
    expect((await request(successorPath, { method: "POST", body: "{}" })).status).toBe(401);
    expect([401, 403]).toContain((await call(successorPath, "POST", {}, { origin: "https://other.example" })).status);
    expect((await call(successorPath, "POST", {})).status).toBe(400);
    const successor = {
      id: randomUUID(),
      successorId: randomUUID(),
      kind: "x-post",
      fingerprint: "a".repeat(64),
      stateToken: "b".repeat(64),
      acceptContinuation: true,
    };
    expect((await call(successorPath, "POST", successor)).status).toBe(404);
    expect((await call(successorPath, "POST", { ...successor, acceptContinuation: false })).status).toBe(400);
    expect((await call(successorPath, "POST", { ...successor, payload: {} })).status).toBe(400);
    await app.stop();
    await app.start();
    expect((await call("/api/social-publications/context?variant=" + variant.variant.id)).status).toBe(200);
    expect((await call("/api/social-publications?space=" + space.id)).body.publications).toEqual([]);
  } finally {
    await app.dispose();
  }
  // Two real process startups and cleanup use the bounded integration budget; each HTTP request has its own limit.
}, 30000);
