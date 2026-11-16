import { expect, test } from "bun:test";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { waitFor } from "../support/app-fixture.mjs";
import { randomUUID } from "node:crypto";

test("authenticated package review, install, pinned builds and disable survive app restart without exposing executable bytes", async () => {
  const fixture = await createSiteBuildFixture(),
    cookies = new Map<string, string>();
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", origin?: string) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(fixture.app.legacyProject(body), { status: 201 })
        : await fetch(fixture.app.base + path, {
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
    expect((await call("/api/document-packages")).status).toBe(401);
    const login = await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    expect(login.status).toBe(200);
    expect((await call("/api/auth/setup", { username: "fixture-owner" })).status).toBe(200);
    expect((await call("/api/document-packages")).body.revision).toBe(0);
    const value = exampleThemePackage();
    const review = await call("/api/document-packages/review", value);
    expect(review.status).toBe(200);
    expect(review.body.addedPermissions).toContain("build:theme-code");
    expect(review.body).not.toHaveProperty("files");
    const approve = {
      package: value,
      approval: {
        digest: review.body.digest,
        expectedRevision: review.body.revision,
        permissions: review.body.permissions,
      },
    };
    expect([401, 403]).toContain(
      (await call("/api/document-packages/install", approve, "POST", "https://other.example")).status,
    );
    expect((await call("/api/document-packages")).body.revision).toBe(0);
    expect(
      (await call("/api/document-packages/install", { ...approve, approval: { ...approve.approval, permissions: [] } }))
        .status,
    ).toBe(403);
    const installed = await call("/api/document-packages/install", approve);
    expect(installed.status).toBe(201);
    expect(installed.body.packages).toHaveLength(1);
    expect(installed.body.installed.installedBy).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(installed.body)).not.toContain("studioMarker()");
    const projectState = await call("/api/projects"),
      catalog = await call("/api/projects", {
        name: "Packages",
        code: "packages",
        revision: projectState.body.revision,
      }),
      project = catalog.body.projects.find((item: { code: string }) => item.code === "packages");
    const {
      body: { space },
    } = await call("/api/document-spaces", {
      projectId: project.id,
      code: "blog",
      name: "Blog",
      engine: "hexo",
      sourceMode: "managed",
      theme: "example.studio.journal@1.0.0",
      locale: "en",
    });
    const doc = await call("/api/documents", {
      spaceId: space.id,
      path: "article.md",
      title: "Article",
      content: "A saved source.",
      locale: "en",
    });
    const variant = await call("/api/publication-variants", {
      documentId: doc.body.document.id,
      revisionId: doc.body.revision.id,
      mode: "format",
      format: "html",
      templateId: "example.studio.paper",
      templateVersion: "1.0.0",
    });
    expect(variant.status).toBe(201);
    expect(variant.body.variant.templateSnapshot.style.accent).toBe("#884422");
    const build = await call("/api/site-builds", {
      id: randomUUID(),
      spaceId: space.id,
      engine: "hexo",
      locale: "en",
      title: "Blog",
      url: "https://example.test",
      basePath: "/",
    });
    expect(build.status).toBe(202);
    expect(build.body.build.theme.schema).toBe(2);
    expect(build.body.build.theme).not.toHaveProperty("bundle");
    await waitFor(() => fixture.inputs.has(build.body.build.id));
    expect(fixture.inputs.get(build.body.build.id).theme.bundle.files.length).toBeGreaterThan(0);
    const changed = exampleThemePackage();
    changed.manifest.description = "Same version, different content.";
    expect((await call("/api/document-packages/review", changed)).status).toBe(409);
    await fixture.app.stop();
    await fixture.app.start();
    const saved = await call("/api/document-packages");
    expect(saved.body.revision).toBe(1);
    expect(saved.body.packages[0].digest).toBe(review.body.digest);
    const disabled = await call(
      "/api/document-packages/state",
      { id: value.manifest.id, version: value.manifest.version, enabled: false, expectedRevision: 1 },
      "PUT",
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.packages[0].active).toBe(false);
    const themes = await call("/api/document-themes?engine=hexo");
    expect(themes.body.themes.every((item: { kind: string }) => item.kind === "builtin")).toBe(true);
    expect((await call("/api/publication-variants/detail?id=" + variant.body.variant.id)).body.digest).toBe(
      variant.body.digest,
    );
    expect(
      (
        await call("/api/document-packages/activate", {
          id: value.manifest.id,
          version: value.manifest.version,
          expectedRevision: 2,
        })
      ).body.code,
    ).toBe("packageDisabled");
    expect(
      (
        await call(
          "/api/document-packages/state",
          { id: value.manifest.id, version: value.manifest.version, enabled: true, expectedRevision: 1 },
          "PUT",
        )
      ).status,
    ).toBe(409);
    expect(
      (await call("/api/document-packages/audit")).body.events.map((event: { action: string }) => event.action),
    ).toEqual(["install", "disable"]);
  } finally {
    await fixture.dispose();
  }
}, 45000);
