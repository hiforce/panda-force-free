import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const proof = process.env.PANDA_SESSION_TOOLBAR_PROOF || ".artifacts/session-list-toolbar";
const app = await createAppFixture({ startupTimeoutMs: 60_000 });
let project;
try {
  await mkdir(proof, { recursive: true });
  for (const [engine, mobile] of [
    [chromium, false],
    [webkit, true],
  ]) {
    const browser = await engine.launch();
    try {
      for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
        const width = mobile ? (locale === "zh-TW" ? 320 : 390) : 1440;
        const context = await browser.newContext({
          viewport: { width, height: 850 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        try {
          await context.addInitScript((language) => {
            localStorage.setItem("panda-force-locale", language);
            localStorage.setItem(
              "panda-force-theme",
              language === "zh-CN" || language === "zh-TW" ? "aurora" : "light",
            );
          }, locale);
          await app.signIn(context);
          if (!project) {
            const url = app.base + "/api/projects";
            const current = await context.request.get(url);
            assert(current.ok());
            const response = await context.request.post(url, {
              headers: { Origin: app.base },
              data: {
                name: "Panda Atlas",
                code: "panda-atlas",
                revision: (await current.json()).revision,
                operationId: crypto.randomUUID(),
              },
            });
            assert(response.ok());
            project = (await response.json()).projects.find((item) => item.code === "panda-atlas");
            assert(project);
          }
          const page = await context.newPage();
          await page.goto(app.base + "/tasks");
          await page.locator("#wbTaskResults .wb-session-entry").first().waitFor();
          const spread = !mobile && (locale === "en" || locale === "zh-CN");
          if (spread) {
            const preference = locale === "en" ? "wide" : "fill";
            await page.locator('[data-chrome-menu="layout"]').click();
            await page.locator(`[data-chrome-action="width"][data-value="${preference}"]`).click();
            assert.equal(await page.locator("html").getAttribute("data-workbench-width"), preference);
          }
          const toolbar = page.locator(".wb-sessions-toolbar");
          const search = toolbar.locator("#wbTaskSearch");
          const filter = toolbar.locator("#wbTaskFilter");
          const create = toolbar.locator(".wb-session-create");
          const label = await page.evaluate(() =>
            globalThis[Symbol.for("PandaForce.browserI18n")].t("common.newSession"),
          );
          assert.equal(await create.getAttribute("aria-label"), label);
          assert.equal(await create.getAttribute("title"), label);
          assert.equal(await create.locator("[data-pf-message]").isVisible(), !mobile);
          assert(await create.locator(".icon-slot").isVisible());
          const bounds = await create.boundingBox();
          const filters = await filter.boundingBox();
          const input = await search.boundingBox();
          assert(Math.abs(input.y + input.height / 2 - (filters.y + filters.height / 2)) <= 1);
          assert(filters.x >= input.x + input.width);
          assert(bounds.x + bounds.width <= width && bounds.width <= (mobile ? 45 : 165));
          assert(bounds.height >= (mobile ? 44 : 40));
          const title = await toolbar.locator(".wb-sessions-title").boundingBox();
          assert(Math.abs(title.y + title.height / 2 - (bounds.y + bounds.height / 2)) <= 1);
          if (mobile) assert(input.y > bounds.y + bounds.height && input.width >= 115);
          else assert(bounds.x + bounds.width <= input.x && Math.abs(bounds.y - input.y) <= 1);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: join(proof, `sessions-${locale}-${width}.png`) });
          await search.fill("session-that-does-not-exist");
          await page.locator("#wbTaskResults .wb-empty").waitFor();
          assert.equal(await page.locator('#workbenchContent [data-wb="new"]').count(), 1);
          await filter.selectOption("common.inProgress");
          assert.equal(await search.inputValue(), "session-that-does-not-exist");
          if (mobile) await create.tap();
          else await create.press("Enter");
          await page.waitForURL((url) => url.pathname === "/new");
          await page.locator("#prompt").waitFor();
          const projectSelect = page.locator("#sessionProjectSelect");
          const folderPicker = page.locator("#conversationProjectPicker");
          const draft = page.locator("#prompt");
          await folderPicker.waitFor();
          await projectSelect.selectOption(project.id);
          await page.waitForURL((url) => url.searchParams.get("project") === project.id);
          await folderPicker.waitFor({ state: "hidden" });
          assert.equal(await projectSelect.locator("option:checked").textContent(), project.name);
          const accessibleHint = await projectSelect.getAttribute("aria-describedby");
          assert((await page.locator("#" + accessibleHint).textContent()).includes(project.workspace.path));
          const projectBounds = await projectSelect.boundingBox();
          const headerRow = page.locator("#workspaceContextHeader .workspace-context-row");
          assert.equal(await headerRow.locator("#sessionProjectSelect").count(), 1);
          const headerBounds = await headerRow.boundingBox();
          const titleBounds = await headerRow.locator(".thread-heading").boundingBox();
          const actionBounds = await headerRow.locator(".workspace-context-actions").boundingBox();
          assert(Math.abs(projectBounds.y + projectBounds.height / 2 - (titleBounds.y + titleBounds.height / 2)) <= 1);
          assert(
            projectBounds.x >= titleBounds.x + titleBounds.width &&
              projectBounds.x + projectBounds.width <= actionBounds.x,
          );
          assert(projectBounds.height >= 44 && headerBounds.height <= projectBounds.height + 1);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          const composerLayout = () =>
            page.locator("#composer").evaluate((composer) => {
              const box = composer.getBoundingClientRect();
              const header = document.querySelector("#workspaceContextHeader").getBoundingClientRect();
              const card = getComputedStyle(composer);
              const dock = getComputedStyle(composer.closest(".composer-dock"));
              return {
                width: box.width,
                leftDifference: box.left - header.left,
                rightDifference: box.right - header.right,
                chrome: [
                  card.backgroundColor,
                  card.borderColor,
                  card.borderRadius,
                  dock.paddingInlineStart,
                  dock.paddingInlineEnd,
                ],
              };
            });
          const draftLayout = await composerLayout();
          assert(Math.abs(draftLayout.leftDifference) <= 1 && Math.abs(draftLayout.rightDifference) <= 1);
          if (spread) assert(draftLayout.width > 900, JSON.stringify(draftLayout));
          await page.screenshot({ path: join(proof, `session-context-${locale}-${width}.png`) });
          await draft.fill("Draft for the selected project.");
          await page.reload();
          await projectSelect.waitFor();
          assert.equal(await projectSelect.inputValue(), project.id);
          await page.waitForFunction(
            () => document.querySelector("#prompt")?.value === "Draft for the selected project.",
          );
          await folderPicker.waitFor({ state: "hidden" });
          await projectSelect.selectOption("");
          await folderPicker.waitFor();
          await page.locator("#composerProjectButton").click();
          await page.locator("#folderDialog").waitFor();
          await page.keyboard.press("Escape");
          await page.locator("#folderDialog").waitFor({ state: "hidden" });
          await page.goto(app.base + "/task/old-alpha");
          await page.locator("body.session-layout #composer").waitFor();
          const activeLayout = await composerLayout();
          assert(Math.abs(activeLayout.leftDifference) <= 1 && Math.abs(activeLayout.rightDifference) <= 1);
          assert(Math.abs(draftLayout.width - activeLayout.width) <= 1);
          assert.deepEqual(draftLayout.chrome, activeLayout.chrome);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log("The sessions toolbar and project context remain compact and usable on PC and H5.");
} finally {
  await app.dispose();
}
