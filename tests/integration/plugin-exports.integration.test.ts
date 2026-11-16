import { expect, test } from "bun:test";
import { createAppFixture } from "../support/app-fixture.mjs";
import { exampleThemePackage } from "../support/theme-package.mjs";
import type { PluginInstallReview, PluginRegistrySnapshot } from "../../src/shared/plugins/registry.js";
import type { PluginExportRef } from "../../src/shared/plugins/exports.js";
import type { TemplateCatalogPage } from "../../src/shared/templates/catalog.js";

test("template selection and individual lifecycle are authenticated, reviewed, durable and reflected by real consumer catalogs", async () => {
  const app = await createAppFixture(),
    cookies = new Map<string, string>();
  async function call<T = { code: string }>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    origin?: string,
  ) {
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
    return { status: response.status, body: (await response.json()) as T };
  }
  const value = exampleThemePackage(),
    paper: PluginExportRef = { kind: "channel-template", id: "paper" },
    journal: PluginExportRef = { kind: "site-theme", id: "journal" };
  try {
    expect((await call("/api/template-catalog")).status).toBe(401);
    expect((await call("/api/document-packages/review-selection", { package: value, selected: [paper] })).status).toBe(
      401,
    );
    await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" });
    await call("/api/auth/setup", { username: "fixture-owner" });
    const catalog = (await call<TemplateCatalogPage>("/api/template-catalog?limit=2")).body;
    // The complete catalog includes seven original resources and eighteen bundled authoring skills.
    expect(catalog.total).toBe(25);
    expect(catalog.templates).toHaveLength(2);
    expect(catalog.nextCursor).not.toBeNull();
    expect((await call("/api/template-catalog?limit=1000")).status).toBe(400);
    expect((await call("/api/template-catalog?category=writing&category=slides")).status).toBe(400);
    expect((await call("/api/document-packages/review-selection", { package: value })).status).toBe(400);
    const review = (
      await call<PluginInstallReview>("/api/document-packages/review-selection", { package: value, selected: [paper] })
    ).body;
    expect(review.permissions).toEqual(["content:templates"]);
    const approved = {
      package: value,
      approval: {
        digest: review.digest,
        expectedRevision: review.revision,
        permissions: review.permissions,
        selected: review.selected,
        reviewHash: review.reviewHash,
      },
    };
    expect((await call("/api/document-packages/install", approved, "POST", "https://other.example")).status).toBe(401);
    expect(
      (
        await call("/api/document-packages/install", {
          ...approved,
          approval: { ...approved.approval, selected: [journal] },
        })
      ).status,
    ).toBe(409);
    const installed = await call<PluginRegistrySnapshot>("/api/document-packages/install", approved);
    expect(installed.status).toBe(201);
    expect(
      (await call("/api/template-catalog?" + new URLSearchParams({ limit: "2", cursor: catalog.nextCursor! }))).status,
    ).toBe(409);
    expect(installed.body.packages[0]?.exports).toEqual([{ ...paper, enabled: true, active: true }]);
    expect(
      (await call<{ themes: { kind: string }[] }>("/api/document-themes?engine=hexo")).body.themes.every(
        (item) => item.kind === "builtin",
      ),
    ).toBe(true);
    const state = {
      id: value.manifest.id,
      version: value.manifest.version,
      export: paper,
      enabled: false,
      expectedRevision: 1,
    };
    expect(
      (await call("/api/document-packages/exports/state", { ...state, export: journal, enabled: true }, "PUT")).status,
    ).toBe(404);
    expect((await call("/api/document-packages/exports/state", state, "PUT")).status).toBe(200);
    await app.stop();
    await app.start();
    const saved = (await call<PluginRegistrySnapshot>("/api/document-packages")).body;
    expect(saved.revision).toBe(2);
    expect(saved.packages[0]?.exports).toEqual([{ ...paper, enabled: false, active: false }]);
    const templates = (await call<TemplateCatalogPage>("/api/template-catalog?state=disabled")).body;
    expect(templates.templates).toHaveLength(1);
    expect(templates.templates[0]?.state).toMatchObject({ enabled: false, packageEnabled: true, exportEnabled: false });
    expect(JSON.stringify(templates)).not.toContain("studioMarker");
    expect((await call("/api/document-packages/exports/state", { ...state, enabled: true }, "PUT")).status).toBe(409);
    expect(
      (
        await call("/api/document-packages/exports/activate", {
          id: state.id,
          version: state.version,
          export: paper,
          expectedRevision: 2,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("/api/document-packages/exports/state", { ...state, enabled: true, expectedRevision: 2 }, "PUT"))
        .status,
    ).toBe(200);
    const activated = await call<PluginRegistrySnapshot>("/api/document-packages/exports/activate", {
      id: state.id,
      version: state.version,
      export: paper,
      expectedRevision: 3,
    });
    expect(activated.status).toBe(200);
    expect(activated.body.packages[0]?.exports).toEqual([{ ...paper, enabled: true, active: true }]);
    const exported = await call<{ files: unknown[] }>(
      "/api/document-packages/export?" + new URLSearchParams({ id: state.id, version: state.version }),
    );
    expect(exported.body.files).toHaveLength(value.files.length);
  } finally {
    await app.dispose();
  }
}, 30000);
