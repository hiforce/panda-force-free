import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { renderCreationSlides } from "../../src/server/creation/integration/rendering/native-slides.js";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = process.env.PANDA_PROJECT_CREATION_PROOF || ".artifacts/project-creation-workspace";
const cdn = process.env.PANDA_FORCE_CDN_BASE_URL;
const app = await createAppFixture({
  freshAdministrator: true,
  startupTimeoutMs: 60_000,
  extraEnvironment: () => (cdn ? { PANDA_FORCE_REQUIRE_CDN: "true", PANDA_FORCE_CDN_BASE_URL: cdn } : {}),
});
const images = await Promise.all(
  ["science-illustration", "information-architecture", "short-film-storyboard"].map((cover) =>
    sharp("public/assets/skill-cover-" + cover + "-v1.webp")
      .resize(720, 480)
      .png()
      .toBuffer(),
  ),
);
const slideDeck = await renderCreationSlides(
  [
    { layout: "picture", title: "Field notes", body: "A project briefing", imageHandle: "1".repeat(64) },
    { layout: "content", title: "Next steps", body: "Review the project checklist." },
  ],
  async () => images[0],
);
const records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    const mobile = engine === webkit;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 880 },
        locale,
        isMobile: mobile,
        hasTouch: mobile,
      });
      const origin = { Origin: app.base };
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(app.base + path)
            : await context.request.post(app.base + path, { data, headers: origin });
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      if (!records.length)
        await api("/api/auth/setup", { username: "fixture-admin", password: "Project-creation-fixture-123" });
      else await api("/api/auth/login", { username: "fixture-admin", password: "Project-creation-fixture-123" });
      if ((await api("/api/system/database")).initialChoiceRequired)
        await api("/api/system/database/selection", { driver: "sqlite" });
      await context.addInitScript(
        ({ locale, theme }) => {
          if (window !== window.top) return;
          localStorage.setItem("panda-force-locale", locale);
          if (!localStorage.getItem("panda-force-sidebar-open"))
            localStorage.setItem("panda-force-sidebar-open", "true");
          localStorage.setItem("panda-force-theme", theme);
        },
        { locale, theme: width === 390 ? "dark" : width === 320 ? "silk" : "aurora" },
      );
      const project = app
        .legacyProject({
          code: "creation-workspace-" + width,
          name:
            width === 320
              ? "PandaForce · Product documentation and cross-team collaboration reference"
              : "Project field guide",
        })
        .projects.find(({ code }) => code === "creation-workspace-" + width);
      const addAsset = async (kind, title, name, bytes) => {
        const params = new URLSearchParams({
          project: project.id,
          kind,
          title,
          name,
          locale,
          id: "c-" + crypto.randomUUID(),
          operationId: crypto.randomUUID(),
        });
        const response = await context.request.post(app.base + "/api/creative-assets/import?" + params, {
          data: Buffer.from(bytes),
          headers: { ...origin, "content-type": "application/octet-stream" },
        });
        assert.equal(response.status(), 201, await response.text());
        return (await response.json()).asset;
      };
      const picture = await addAsset("image", "Field illustration", "field.png", images[0]);
      await addAsset("image", "Project diagram", "diagram.png", images[1]);
      await addAsset("image", "Story boards", "storyboards.png", images[2]);
      const slides = await addAsset("slides", "Project briefing", "project.pptx", slideDeck.bytes);
      const web = await addAsset(
        "web",
        "Project guide",
        "guide.html",
        "<!doctype html><html><head><meta name=viewport content='width=device-width'></head><body style='font: 18px system-ui; margin: 24px'><h1>Project guide</h1><p>Read the field notes before continuing.</p></body></html>",
      );
      const file = await addAsset("file", "Checklist", "checklist.txt", "Upload reference materials.");
      const path = app.base + "/project?id=" + project.id;
      const page = await context.newPage();
      const requests = new Set(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => requests.add(request.url()));
      await page.goto(app.base + "/projects", { waitUntil: "domcontentloaded" });
      if (!mobile) await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
      await page
        .locator('.project-directory-main[href="/project?id=' + project.id + '"]')
        .first()
        .click();
      const heading = page.locator(".project-overview-heading");
      const creation = page.locator(".project-creation-strip");
      const category = (kind) => creation.locator('[data-creative-filter="' + kind + '"]');
      const picker = page.locator("#projectCreationCategory");
      const selectCategory = async (kind) => {
        if (!mobile) return category(kind).click();
        await picker.focus();
        assert(await picker.evaluate((control) => control === document.activeElement));
        await picker.selectOption(kind);
        assert.notEqual(
          await page.evaluate(() => document.activeElement?.id),
          "projectCreationCategory",
          "Committing a category releases the native picker before changing the view",
        );
      };
      await (mobile ? picker : creation).waitFor();
      assert.equal(await heading.locator("h1").textContent(), project.name);
      if (width === 320) {
        const name = heading.locator(".project-name-disclosure");
        await name.locator("summary").click();
        assert.equal(await name.locator(".project-full-name").innerText(), project.name);
        const settings = await heading.locator("[data-wb=project-edit]").boundingBox();
        assert(settings.x + settings.width <= width);
        await name.locator("summary").click();
      }
      assert.equal(await page.locator("[data-system-composer]").isVisible(), false);
      assert.equal(await page.locator(".topbar").isVisible(), !mobile);
      await page.locator(".project-gallery-grid[data-gallery-layout=rows]").waitFor();
      const galleryBounds = await page.locator(".project-gallery").boundingBox();
      if (mobile) {
        assert.equal(await picker.inputValue(), "all");
        const options = picker.locator("option:not([hidden])");
        assert.deepEqual(await options.evaluateAll((items) => items.map((item) => item.value)), [
          "all",
          "document",
          "image",
          "slides",
          "web",
        ]);
        assert((await options.allTextContents()).every((name) => name.trim()));
        assert.equal(await creation.isVisible(), false);
        assert.equal(await page.locator(".workbench-mobile-nav").isVisible(), false);
        assert(galleryBounds.width >= width - 56, "The catalogue fills the available phone width");
        const [selectorBounds, actionBounds] = await Promise.all([
          picker.boundingBox(),
          page.locator(".project-create-menu > summary").boundingBox(),
        ]);
        assert(Math.abs(selectorBounds.y - actionBounds.y) <= 2);
      } else {
        assert.equal(await category("all").getAttribute("aria-current"), "page");
        assert.equal(await creation.locator("[data-creative-filter]").count(), 5);
        const categoryBounds = await creation.boundingBox();
        assert(categoryBounds.x + categoryBounds.width <= galleryBounds.x);
        assert(categoryBounds.width <= 56, "The category rail fits the icon targets");
        const expected = await category("image").getAttribute("aria-label");
        assert(expected);
        await category("image").hover();
        const label = await category("image").evaluate((link) => getComputedStyle(link, "::after").content);
        assert(label.includes(expected));
        await page.mouse.move(1, 1);
      }
      await page.locator('[data-creative-asset="' + file.id + '"]').waitFor();
      if (!mobile) await page.waitForFunction(() => document.body.classList.contains("sidebar-hidden"));
      await page.screenshot({ path: out + "/all-" + width + ".png" });
      const reader = page.locator("[data-project-asset-reader]");
      const openAsset = async (asset) => {
        await page.locator('[data-creative-asset="' + asset.id + '"]').click();
        await reader.waitFor();
        assert.equal(new URL(page.url()).searchParams.get("asset"), asset.id);
        if (mobile) {
          assert.equal(await page.locator(".workbench-mobile-nav").isVisible(), false);
          assert.equal(await picker.isVisible(), false);
        } else {
          assert.equal(await page.locator(".project-gallery-catalog").isVisible(), true);
          assert.equal(await creation.isVisible(), true);
          const projectBar = await heading.boundingBox(),
            assetBar = await reader.locator(".project-asset-bar").boundingBox();
          assert(Math.abs(projectBar.y - assetBar.y) <= 2);
        }
      };
      const closeAsset = async () => {
        await reader.locator("[data-project-asset-close]").click();
        await reader.waitFor({ state: "hidden" });
        assert.equal(new URL(page.url()).searchParams.has("asset"), false);
      };
      await selectCategory("image");
      await page.waitForURL((url) => url.searchParams.get("kind") === "image");
      if (mobile) {
        assert.equal(await picker.inputValue(), "image");
        await page.goBack();
        assert.equal(await picker.inputValue(), "all");
        await page.goForward();
        assert.equal(await picker.inputValue(), "image");
        assert.notEqual(await page.evaluate(() => document.activeElement?.id), "projectCreationCategory");
      } else assert.equal(await category("image").getAttribute("aria-current"), "page");
      const thumbnail = page.locator("[data-gallery-category=image] [data-creative-cover]:visible");
      await thumbnail.nth(2).waitFor();
      const galleryTitle = page.locator(".project-gallery-tools h2");
      assert((await galleryTitle.boundingBox()).height <= 24);
      await page.screenshot({ path: out + "/images-" + width + ".png" });
      const searchAsset = page.locator("[data-creative-search]");
      await searchAsset.fill("Field illustration");
      let failedOnce = false;
      await page.route("**/api/creative-assets/item?**", (request) => {
        if (!failedOnce) {
          failedOnce = true;
          return request.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        }
        return request.continue();
      });
      await openAsset(picture);
      await reader.locator("[data-asset-view-retry]").click();
      const original = reader.locator("img[data-asset-native]");
      await original.waitFor();
      await page.waitForFunction(() => document.querySelector("img[data-asset-native]")?.naturalWidth === 720);
      await page.screenshot({ path: out + "/image-reader-" + width + ".png" });
      await closeAsset();
      assert.equal(await searchAsset.inputValue(), "Field illustration");
      assert(
        await page
          .locator('[data-creative-asset="' + picture.id + '"]')
          .evaluate((el) => el === document.activeElement),
      );
      await searchAsset.fill("");
      await page.unroute("**/api/creative-assets/item?**");
      await selectCategory("slides");
      await page.waitForURL((url) => url.searchParams.get("kind") === "slides");
      await page.locator(".project-gallery-upload:enabled").click();
      const dialog = page.locator(".creative-asset-dialog[open]");
      const input = dialog.locator("input[type=file]");
      assert.equal(await input.getAttribute("accept"), ".pptx");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.locator('[data-creative-asset="' + slides.id + '"]').waitFor();
      await page.screenshot({ path: out + "/slides-" + width + ".png" });
      await openAsset(slides);
      await reader.locator("[data-slide-image]:visible").waitFor({ timeout: 45000 });
      await reader.locator("[data-slide-next]").click();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-slide-next]")?.disabled &&
          !document.querySelector("[data-slide-previous]")?.disabled,
      );
      await page.screenshot({ path: out + "/slides-reader-" + width + ".png" });
      await closeAsset();
      await selectCategory("web");
      await page.waitForURL((url) => url.searchParams.get("kind") === "web");
      await page.locator(".project-gallery-row").waitFor();
      await page.screenshot({ path: out + "/web-" + width + ".png" });
      await openAsset(web);
      assert.equal(await reader.locator("[data-asset-frame]").getAttribute("sandbox"), "");
      await reader.frameLocator("[data-asset-frame]").getByText("Project guide").waitFor();
      await page.screenshot({ path: out + "/web-reader-" + width + ".png" });
      if (!mobile) {
        await reader.locator("[data-project-asset-close]").focus();
        await page.keyboard.press("Escape");
        await reader.waitFor({ state: "hidden" });
      } else await closeAsset();
      await selectCategory("all");
      await page.locator("[data-project-trash]:visible").click();
      await page.waitForURL((url) => url.searchParams.get("kind") === "trash");
      await selectCategory("all");
      await page.locator(".project-create-menu > summary").click();
      await page.locator("[data-project-compose]").click();
      await page.locator("#gadgetDocumentPrompt:visible").waitFor();
      await selectCategory("document");
      const tree = page.locator("#authoringDirectory");
      const search = tree.locator("#documentSearch");
      await search.waitFor();
      await page.waitForFunction(() => !document.getElementById("documentSearch")?.disabled);
      assert.equal(new URL(page.url()).searchParams.get("tab"), "documents");
      assert.equal(await page.locator(".project-document-welcome").isVisible(), !mobile);
      if (!mobile)
        assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("sidebar-hidden")), true);
      const first = await api("/api/project-document-tree/documents", {
        id: crypto.randomUUID(),
        projectId: project.id,
        treeVersion: 0,
        title: "Field notes",
        parentId: null,
        locale: "en",
      });
      const second = await api("/api/project-document-tree/documents", {
        id: crypto.randomUUID(),
        projectId: project.id,
        treeVersion: first.tree.version,
        title: "Reading guide",
        parentId: first.operation.documentId,
        locale: "en",
      });
      const documentId = second.operation.documentId;
      await page.reload({ waitUntil: "domcontentloaded" });
      const row = tree.locator(".document-tree-title").filter({ hasText: "Reading guide" });
      await row.waitFor();
      const [headerRect, treeRect] = await Promise.all([heading.boundingBox(), tree.boundingBox()]);
      assert(headerRect.height <= (mobile ? 96 : 48), "Compact header: " + headerRect.height);
      if (mobile) {
        assert.equal(await picker.inputValue(), "document");
        assert(treeRect.width >= width - 56, "The document directory fills the available phone width");
      } else {
        const railRect = await creation.boundingBox();
        assert(railRect.x + railRect.width <= treeRect.x);
      }
      assert(treeRect.y - headerRect.y <= (mobile ? 160 : 133), "Directory starts close to the header");
      const directoryHeading = await tree.locator(".authoring-directory-heading").boundingBox();
      const searchRect = await search.boundingBox();
      assert(directoryHeading.y - treeRect.y <= 16, "Directory title sits at the top of the pane");
      await page.screenshot({ path: out + "/directory-" + width + ".png" });
      assert(
        searchRect.y - treeRect.y <= (mobile ? 68 : 48),
        "Search follows the compact directory heading: " + (searchRect.y - treeRect.y),
      );
      await search.fill("Reading");
      await row.click();
      const back = page.locator('[data-authoring-action="close-project-document"]:visible');
      await back.waitFor();
      assert.equal(new URL(page.url()).searchParams.get("document"), documentId);
      assert.equal(new URL(page.url()).pathname, "/project");
      if (mobile) {
        assert.equal(await heading.isVisible(), false);
        assert.equal(await tree.isVisible(), false);
        assert.equal(await picker.isVisible(), false);
        assert.equal(await page.locator(".workbench-mobile-nav").isVisible(), false);
        assert(await back.evaluate((element) => element === document.activeElement));
        assert((await back.boundingBox()).y < 20);
        assert((await page.locator("#documentReadTitle").boundingBox()).y < 105);
        assert.equal(await page.locator(".authoring-reader-tools").count(), 0);
        await page.locator('.document-authoring-editor-header [data-doc-action="edit"]').click();
        await page.locator(".is-editing #documentTitle").waitFor();
        await page.locator('[data-doc-action="preview"]:visible').first().click();
        await back.waitFor();
      } else {
        const [a, b] = await Promise.all([tree.boundingBox(), page.locator("#documentEditor").boundingBox()]);
        assert(a.x + a.width <= b.x + 1);
        assert(
          b.width > 1000 && b.height > 640,
          "The document surface uses the reclaimed desktop space: " + JSON.stringify(b),
        );
        assert.equal(await creation.isVisible(), true);
        const titleBar = await heading.boundingBox();
        const commandBar = await page.locator(".document-authoring-editor-header").boundingBox();
        assert(Math.abs(titleBar.y - commandBar.y) <= 2);
        assert(titleBar.x + titleBar.width <= commandBar.x + 1);
      }
      await page.screenshot({ path: out + "/reading-" + width + ".png" });
      await back.click();
      assert.equal(await search.inputValue(), "Reading");
      assert.equal(await (mobile ? picker : creation).isVisible(), true);
      assert(await row.evaluate((element) => element === document.activeElement));
      assert.equal(new URL(page.url()).searchParams.has("document"), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.goto(path + "&tab=documents&document=" + documentId);
      await back.waitFor();
      if (cdn) {
        const { assets } = await Bun.file("public/cdn-manifest.json").json();
        for (const asset of [
          "/app.bundle.js",
          "/workbench.css",
          "/workbench-layout.css",
          "/creative.css",
          "/document-authoring.css",
          "/document-workspace.css",
          "/http-client.js",
          "/content-workspace.bundle.js",
          "/creative-assets.bundle.js",
          "/gadget-document.bundle.js",
        ])
          assert(requests.has(assets[asset].url), "Expected CDN download for " + asset);
        for (const target of requests) {
          const url = new URL(target);
          if (url.pathname.startsWith("/api/")) assert.equal(url.origin, app.base);
          assert(!(url.origin === app.base && assets[url.pathname]));
        }
      }
      await back.click();
      const linkSessions = async (sessionIds) => {
        const { revision } = await api("/api/projects");
        await api("/api/projects/assign", { revision, projectId: project.id, sessionIds });
      };
      const createSession = async (cwd, name) => {
        const started = await api("/api/rpc", { id: crypto.randomUUID(), method: "thread/start", params: { cwd } });
        const id = started.result?.thread?.id;
        assert(id);
        await api("/api/rpc", { id: crypto.randomUUID(), method: "thread/name/set", params: { threadId: id, name } });
        return id;
      };
      const firstSessionId = await createSession(
        app.alpha,
        locale === "zh-CN" ? "梳理项目资料" : "Organize project materials",
      );
      const secondSessionId = await createSession(
        app.alpha,
        locale === "zh-CN" ? "讨论下一版功能" : "Discuss the next release",
      );
      await linkSessions([firstSessionId, secondSessionId]);
      const sessionsTab = page.locator(".resource-project-tabs a[href*='tab=sessions']");
      await sessionsTab.click();
      const toolbar = page.locator(".project-session-tools");
      const sessionList = page.locator("#projectSessionResults");
      const sessionRow = (id) => sessionList.locator('.wb-task-row[data-id="' + id + '"]');
      await sessionRow(firstSessionId).waitFor();
      await sessionRow(secondSessionId).waitFor();
      const workingFolder = page.locator("#projectSessionDirectory");
      const sessionSearch = toolbar.locator("#projectSessionSearch");
      const sessionCount = page.locator("#projectSessionCount");
      assert.match(await sessionCount.innerText(), /2/);
      assert.equal(await workingFolder.count(), 0, "A shared working folder needs no filter");
      assert.equal(await sessionList.locator(".wb-task-location, .wb-task-model").count(), 0);
      assert.equal(await sessionList.locator(".wb-task-state").count(), 2);
      assert.equal(await sessionList.locator("time").count(), 2);
      assert.equal(await toolbar.locator("[data-wb=project-link]").isVisible(), true);
      assert.equal(await toolbar.locator("[data-wb=project-new]").isVisible(), true);
      const sessionTools = await toolbar.boundingBox();
      assert(sessionTools.height <= 48, "Project session tools fit on one row");
      const firstSession = await sessionList.locator(".wb-task-row").first().boundingBox();
      assert(firstSession.y - sessionTools.y - sessionTools.height <= 68, "Sessions start directly below the toolbar");
      await page.screenshot({ path: out + "/sessions-" + width + ".png" });
      const externalSessionId = await createSession(app.beta, "Beta work plan");
      await linkSessions([firstSessionId, secondSessionId, externalSessionId]);
      await sessionRow(externalSessionId).waitFor();
      const label = await workingFolder.getAttribute("aria-label");
      assert(label && (await workingFolder.isVisible()));
      await page.screenshot({ path: out + "/session-folders-" + width + ".png" });
      await sessionSearch.fill("beta");
      await workingFolder.selectOption(app.alpha);
      assert.equal(await sessionList.locator(".wb-task-row").count(), 0);
      assert.match(await sessionCount.innerText(), /0/);
      await workingFolder.selectOption(app.beta);
      assert.equal(await sessionRow(externalSessionId).count(), 1);
      assert.match(await sessionCount.innerText(), /1/);
      assert.equal(await sessionSearch.inputValue(), "beta");
      await page.locator(".resource-project-tabs a").first().click();
      await sessionsTab.click();
      assert.equal(await workingFolder.inputValue(), app.beta);
      assert.equal(await sessionSearch.inputValue(), "beta");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (!mobile) {
        assert(await page.locator("body").evaluate((body) => body.classList.contains("sidebar-hidden")));
        await page.locator(".resource-project-tabs a[href*='tab=memory']").click();
        await page.locator(".project-memory-view").waitFor();
        assert(await page.locator("body").evaluate((body) => body.classList.contains("sidebar-hidden")));
        await page.locator(".resource-project-tabs a[href^='/publish?project=']").click();
        await page.locator(".project-publish-view").waitFor();
        assert(await page.locator("body").evaluate((body) => body.classList.contains("sidebar-hidden")));
        await page.locator(".project-breadcrumb a").first().click();
        await page.waitForURL((url) => url.pathname === "/projects");
        await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
      }
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        mobile,
        header: headerRect.height,
        directoryTop: treeRect.y,
        sameProjectReader: true,
        inlineMediaAndRetry: true,
        projectSidebarHidden: true,
        compactProjectSessions: true,
        categoryNavigation: mobile ? "full-width-picker" : "icon-rail",
        directoryFocusRestored: true,
        cdn: !!cdn,
      });
    } finally {
      await browser.close();
    }
  }
  await writeFile(out + "/results.json", JSON.stringify({ passed: true, records }, null, 2) + "\n");
} finally {
  await app.dispose();
}
