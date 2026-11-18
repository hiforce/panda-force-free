import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const app = await createAppFixture({
  startupTimeoutMs: 90000,
  applicationCreation: true,
  models: [
    {
      id: "gpt-fixture",
      model: "gpt-fixture",
      isDefault: true,
      displayName: "Fixture model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
  ],
  applicationArtifact: {
    kind: "web",
    arguments: { slot: 1, html: "<!doctype html><html><body><h1>A generated project page</h1></body></html>" },
  },
});
try {
  for (const legacy of [false, true]) {
    const browser = await (legacy ? webkit : chromium).launch();
    try {
      const context = await browser.newContext({ viewport: { width: legacy ? 390 : 1440, height: 960 } });
      await app.signIn(context);
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data, headers: { Origin: app.base } });
        assert(response.ok(), await response.text());
        return response.json();
      };
      const catalog = await api("/api/projects"),
        code = legacy ? "legacy-files" : "originals-recovery";
      const created = legacy
        ? app.legacyProject({ code, name: code, revision: catalog.revision })
        : await api("/api/projects", { code, name: code, revision: catalog.revision });
      const project = created.projects.find((value) => value.code === code);
      if (!legacy)
        for (const name of ["First.txt", "Second.txt", "Target.txt"]) {
          const params = new URLSearchParams({
            project: project.id,
            id: "c-" + randomUUID(),
            operationId: randomUUID(),
            kind: "file",
            name,
            title: name,
            locale: "en",
          });
          const response = await context.request.post(app.base + "/api/creative-assets/import?" + params, {
            data: Buffer.from(name),
            headers: { "content-type": "application/octet-stream", Origin: app.base },
          });
          assert.equal(response.status(), 201, await response.text());
        }
      const page = await context.newPage(),
        errors = [],
        requests = [];
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/creative-assets")) requests.push(request.url());
      });
      if (!legacy) {
        const real = (await api("/api/creative-assets?" + new URLSearchParams({ project: project.id }))).assets.sort(
          (a, b) => a.title.localeCompare(b.title),
        );
        // Only pagination and capability display are controlled; all opened originals use the authenticated real API.
        await page.route("**/api/creative-assets?*", async (route) => {
          const more = new URL(route.request().url()).searchParams.has("cursor");
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              assets: more ? real.slice(2) : real.slice(0, 2),
              nextCursor: more ? null : "controlled-pagination",
            }),
          });
        });
        await page.route("**/api/creative-assets/capabilities?*", async (route) => {
          const response = await route.fetch();
          const value = await response.json();
          await route.fulfill({ response, json: { ...value, contribute: false } });
        });
        await page.route("**/creative-assets.bundle.js*", (route) => route.abort("connectionrefused"));
      }
      await page.goto(app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.locator('[data-authoring-action="new"]').click();
      await page.locator('.document-rich-content[contenteditable="true"]').waitFor();
      if (legacy) {
        await page.locator(".document-editor-more > summary").click();
        await page.locator('.document-editor-more [data-authoring-action="reader-directory"]').click();
        await page.locator("#authoringDirectory").waitFor();
        assert.equal(await page.locator(".authoring-files").isVisible(), false);
        assert.equal(requests.length, 0);
        await page.locator('[data-authoring-action="directory-dismiss"]').click();
        assert.equal(
          await page
            .locator(".document-editor-more > summary")
            .evaluate((element) => document.activeElement === element),
          true,
        );
      } else {
        await page.locator('.authoring-files [data-file-action="open"]').first().waitFor();
        assert.equal(await page.locator('.authoring-files [data-file-action="import"]').count(), 0);
        await page.locator("#documentSearch").fill("Target.txt");
        await waitFor(async () => (await page.locator('.authoring-files [data-file-action="open"]').count()) === 0);
        await page.locator('[data-file-action="more"]').click();
        await page.locator('.authoring-files [data-file-action="open"]').click();
        await page.locator('[data-file-action="retry-open"]').waitFor();
        assert.equal(await page.locator("#documentSearch").inputValue(), "Target.txt");
        await page.unroute("**/creative-assets.bundle.js*");
        await page.locator('[data-file-action="retry-open"]').click();
        const dialog = page.locator("#authoringFileDialog[open]");
        await dialog.locator("a[download]").first().waitFor();
        assert.equal(await dialog.locator("pre").innerText(), "Target.txt");
        assert.equal(await dialog.locator("[data-asset-replace],[data-asset-trash]").count(), 0);
        await dialog.locator("[data-doc-close]").click();
        await page.unroute("**/api/creative-assets?*");
        await page.unroute("**/api/creative-assets/capabilities?*");
        await page.locator('[data-authoring-action="new-ai"]').first().click();
        const creation = page.locator(".creation-dialog[open]");
        await creation.locator('[name="prompt"]').fill("Create a real HTML page for this project.");
        await creation.locator("[data-creation-submit]").click();
        await creation.locator('[data-creation-action="open"]').first().click({ timeout: 45000 });
        await page.locator("#authoringFileDialog[open] [data-asset-frame]").waitFor();
        const originals = await api("/api/creative-assets?" + new URLSearchParams({ project: project.id }));
        assert(originals.assets.some((asset) => asset.kind === "web"));
        await page.locator("#authoringFileDialog [data-doc-close]").click();
        assert.equal(await page.locator("#documentSearch").inputValue(), "Target.txt");
        await page.locator("#documentSearch").fill("");
        await waitFor(async () => (await page.locator('.authoring-files [data-file-action="open"]').count()) === 4);
      }
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Real legacy project compatibility, controlled read-only display, loaded-file pagination, failed-module retry and controlled-CLI real project HTML task navigation passed.",
  );
} finally {
  await app.dispose();
}
