import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppFixture } from "../support/app-fixture.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";

test("public source profiles persist, share optimistic space versions and reject unsafe requests before packaging", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-profile-api-")),
    source = join(root, "blog");
  await mkdir(join(source, "source-en/_posts"), { recursive: true });
  await mkdir(join(source, "themes/journal/layout"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ dependencies: { hexo: "8.1.1" } }));
  await writeFile(
    join(source, "_config.yml"),
    "title: Original journal\nurl: https://example.test\nroot: /\ntheme_config:\n  private_token: never-expose\n  label: Public\n",
  );
  await writeFile(join(source, "themes/journal/layout/layout.ejs"), "<%- body %>");
  const app = await createAppFixture({ workspaceDirectory: root }),
    cookies = new Map<string, string>();
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", origin?: string) => {
    const response =
      path === "/api/projects" && method === "POST"
        ? Response.json(app.legacyProject(body), { status: 201 })
        : await fetch(app.base + path, {
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
    expect((await call("/api/document-packages/from-source", {})).status).toBe(401);
    expect((await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" })).status).toBe(
      200,
    );
    expect((await call("/api/document-packages/from-source", {})).status).toBe(403);
    await call("/api/auth/setup", { username: "fixture-owner" });
    const catalog = await call("/api/projects"),
      projects = await call("/api/projects", {
        revision: catalog.body.revision,
        name: "Profile API",
        code: "profile-api",
      }),
      project = projects.body.projects.find((p: { code: string }) => p.code === "profile-api");
    const created = await call("/api/document-spaces", {
        projectId: project.id,
        code: "blog",
        name: "Journal",
        engine: "hexo",
        sourceMode: "external",
        sourceRoot: source,
        locale: "en",
      }),
      space = created.body.space;
    const path = "/api/document-spaces/source-profile?id=" + space.id;
    expect((await call(path)).body.profile).toBe(null);
    const proposal = await call("/api/document-spaces/source-profile/inspect", {
      id: space.id,
      locale: "en",
      files: ["_config.yml"],
      webp: false,
    });
    expect(proposal.status).toBe(200);
    expect(proposal.body.omitted).toContain("theme_config.private_token");
    expect(JSON.stringify(proposal.body)).not.toContain("never-expose");
    const profile = proposal.body.profile;
    expect([401, 403]).toContain(
      (await call(path, { version: space.version, profile }, "PUT", "https://another.example")).status,
    );
    expect((await call(path, { version: space.version, profile }, "PUT")).body.space.version).toBe(space.version + 1);
    expect((await call(path, { version: space.version, profile }, "PUT")).status).toBe(409);
    expect(
      (await call(path, { version: space.version + 1, profile: { ...profile, command: "arbitrary-command" } }, "PUT"))
        .status,
    ).toBe(400);
    expect(
      (
        await call("/api/document-spaces/source-profile/inspect", {
          id: space.id,
          locale: "en",
          files: ["../outside.yml"],
          webp: false,
        })
      ).status,
    ).toBe(400);
    const manifest = exampleThemePackage().manifest;
    manifest.channelTemplates = [];
    manifest.siteThemes = [manifest.siteThemes[0]];
    manifest.permissions = ["content:site-themes", "build:theme-code"];
    const rejectedOrigin = await call(
      "/api/document-packages/from-source",
      { spaceId: space.id, theme: "journal", manifest },
      "POST",
      "https://another.example",
    );
    expect([401, 403]).toContain(rejectedOrigin.status);
    expect(
      (await call("/api/document-packages/from-source", { spaceId: space.id, theme: "../outside", manifest })).status,
    ).toBe(400);
    const pack = await call("/api/document-packages/from-source", { spaceId: space.id, theme: "journal", manifest });
    expect(pack.status).toBe(200);
    expect(pack.body.fileCount).toBe(1);
    expect((await call("/api/document-packages")).body.packages).toHaveLength(0);
    await app.stop();
    await app.start();
    expect((await call(path)).body.profile).toEqual(profile);
    expect((await call(path)).body.space.version).toBe(space.version + 1);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
