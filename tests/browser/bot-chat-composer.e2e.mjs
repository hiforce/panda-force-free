import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const markdown =
    "# A document for this conversation\n\nThe project source and attached photograph remain reference materials.",
  app = await createAppFixture({
    applicationChat: true,
    startupTimeoutMs: 60000,
    sharedApprovals: true,
    applicationChatReply: "```markdown\n" + markdown + "\n```",
  }),
  out = process.env.PANDA_FORCE_BOT_SCREENSHOTS || ".artifacts/bot-chat-composer/screens",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
    [chromium, 1100, "zh-HK", "silk"],
    [webkit, 320, "zh-TW", "aurora"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        acceptDownloads: true,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
    try {
      await context.addInitScript(
        ({ locale, theme }) => {
          if (location.protocol.startsWith("http")) {
            localStorage.setItem("panda-force-locale", locale);
            localStorage.setItem("panda-force-theme", theme);
          }
        },
        { locale, theme },
      );
      await app.signIn(context);
      const api = async (path, data, method = data ? "POST" : "GET") => {
        const response = await context.request.fetch(app.base + path, {
          method,
          headers: { Origin: app.base },
          ...(data ? { data } : {}),
        });
        assert(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalog = await api("/api/projects"),
        project = (
          await api("/api/projects", {
            name: "Reference project " + locale,
            code: "bot-context-" + locale.toLowerCase(),
            revision: catalog.revision,
          })
        ).projects.find((p) => p.code === "bot-context-" + locale.toLowerCase()),
        tree = await api("/api/project-document-tree?project=" + project.id),
        created = await api("/api/project-document-tree/documents", {
          id: crypto.randomUUID(),
          projectId: project.id,
          treeVersion: tree.version,
          title: "Pinned source",
          locale: "en",
          parentId: null,
        }),
        sourceQuery = new URLSearchParams({ project: project.id, id: created.operation.documentId }),
        source = await api("/api/project-documents/editor?" + sourceQuery),
        savedDraft = await api(
          "/api/project-documents/editor?" + sourceQuery,
          {
            operationId: crypto.randomUUID(),
            version: source.draft.version,
            baseRevisionId: source.draft.baseRevisionId,
            working: {
              title: "Pinned source",
              locale: "en",
              content: "# Pinned source\n\nReference content.\n",
              resources: [],
              body: {
                schema: 1,
                format: "richtext",
                document: {
                  type: "doc",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Reference content." }] }],
                },
              },
            },
          },
          "PUT",
        ),
        savedSource = await api("/api/project-documents/checkpoints?" + sourceQuery, {
          operationId: crypto.randomUUID(),
          draftVersion: savedDraft.receipt.version,
          revisionId: source.saved.revision.id,
        }),
        { bot } = await api("/api/bots", {
          name: "Conversation helper " + locale,
          code: "chat-input-" + locale.toLowerCase(),
        }),
        treeBefore = await api("/api/project-document-tree?project=" + project.id),
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/bots/" + bot.id + "/chat");
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      const form = page.locator(".bot-chat-composer"),
        plus = form.locator("[data-composer-control=add]"),
        input = form.locator("[data-message]"),
        menu = page.locator(".composer-add-menu[open]");
      await input.fill("Create a document using the selected references and skill.");
      await plus.click();
      assert.equal(await menu.locator("[data-add-upload]").count(), 3);
      await page.screenshot({ path: `${out}/add-${locale}-${width}.png` });
      await page.keyboard.press("Escape");
      assert(await plus.evaluate((el) => el === document.activeElement));
      await plus.click();
      const chooser = page.waitForEvent("filechooser");
      await menu.locator('[data-add-upload="photos"]').click();
      await (
        await chooser
      ).setFiles({
        name: "reference.png",
        mimeType: "image/png",
        buffer: await readFile("public/assets/panda-icon.png"),
      });
      await form.locator('.composer-attachment[data-status="ready"]').waitFor();
      let failUpload = true;
      await page.route("**/api/chat-materials?*", async (route) => {
        if (failUpload) {
          failUpload = false;
          await route.abort();
        } else await route.continue();
      });
      await plus.click();
      const fileChooser = page.waitForEvent("filechooser");
      await menu.locator('[data-add-upload="files"]').click();
      await (
        await fileChooser
      ).setFiles({ name: "brief.txt", mimeType: "text/plain", buffer: Buffer.from("Human reference text.") });
      const failed = page.locator('.composer-attachment[data-status="failed"]');
      await failed.waitFor({ state: "attached" });
      if (!(await failed.isVisible())) await form.locator('[data-manage-composer-context="files"]').click();
      assert(await form.locator("[type=submit]").isDisabled());
      await failed.locator("button").first().click();
      await page.waitForFunction(
        () => document.querySelectorAll('.composer-attachment[data-status="ready"]').length === 2,
      );
      const filesDialog = page.locator(".message-composer-context-dialog[open]");
      if (await filesDialog.count()) await filesDialog.locator(".composer-panel-action").click();
      await plus.click();
      await menu.locator("[data-composer-skill-trigger]").click();
      const skills = page.locator(".creation-skill-browser[open]");
      await skills.locator('[data-skill-id="software-prd"]').click();
      assert.equal(await page.locator("dialog[open]").count(), 1);
      if (width < 768) {
        await page.setViewportSize({ width, height: 500 });
        await page.waitForFunction(() => {
          const rect = document.querySelector(".creation-skill-browser[open]").getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight + 1;
        });
        await page.screenshot({ path: `${out}/skills-short-${locale}-${width}.png` });
        await page.setViewportSize({ width, height: 960 });
      }
      await page.screenshot({ path: `${out}/skills-${locale}-${width}.png` });
      await skills.locator("[data-skill-browser-close]").last().click();
      await plus.click();
      await menu.locator("[data-add-documents]").click();
      await menu.locator("[data-add-project]:enabled").waitFor();
      await menu.locator("[data-add-project]").selectOption(project.id);
      await menu.locator("[data-add-document]").first().waitFor();
      await page.screenshot({ path: `${out}/documents-${locale}-${width}.png` });
      await menu.locator("[data-add-document]").first().click();
      await page.waitForFunction(
        () => document.querySelectorAll('.bot-chat-composer .composer-attachment[data-status="ready"]').length === 3,
      );
      await page.locator("[data-chat-options]").click();
      await page.locator(`.bot-chat-menu [data-route="/bots/${bot.id}/tasks"]`).click();
      await page.locator("[data-bot-task-rows]").waitFor();
      await page.goBack();
      await page.locator("[data-clear]:enabled").waitFor({ state: "attached" });
      assert.equal(await input.inputValue(), "Create a document using the selected references and skill.");
      assert.equal(await form.locator(".composer-attachment").count(), 3);
      assert.equal(await form.locator("[data-selected-skill]").count(), 1);
      await page.screenshot({ path: `${out}/composer-${locale}-${width}.png` });
      let submitted,
        lost = false;
      await page.route(`**/api/bots/${bot.id}/chat`, async (route) => {
        if (route.request().method() === "POST" && !lost) {
          submitted = route.request().postDataJSON();
          lost = true;
          await route.fetch();
          await route.abort();
        } else await route.continue();
      });
      await form.locator("[type=submit]").click();
      const content = page.locator(".bot-chat-content-card").first();
      await content.waitFor().catch(async (error) => {
        console.log(
          "Chat state",
          JSON.stringify(await api(`/api/bots/${bot.id}/chat`)),
          "Input",
          submitted,
          "Page",
          (await page.locator("body").innerText()).slice(-2500),
          errors,
        );
        await page.screenshot({ path: `${out}/failure-${locale}-${width}.png` });
        throw error;
      });
      await page.waitForFunction(
        () => document.querySelectorAll(".bot-chat-composer .composer-attachment").length === 0,
      );
      assert.equal(submitted.attachments.length, 3);
      assert.equal(submitted.selections[0].id, "software-prd");
      const snapshot = await api(`/api/bots/${bot.id}/chat`);
      assert.equal(snapshot.messages.length, 2, "An uncertain send must not duplicate the message");
      assert.equal(snapshot.messages[0].materials.length, 3);
      assert.equal(await form.locator("[data-selected-skill]").count(), 0);
      const pinned = snapshot.messages[0].materials.find((m) => m.name === "Pinned source.md"),
        original = await context.request.get(app.base + "/api/chat-materials/original?id=" + pinned.id);
      assert.equal(await original.text(), savedSource.detail.revision.content);
      const download = page.waitForEvent("download");
      await content.locator("[data-download-content]").click();
      const saved = await download;
      assert.equal(saved.suggestedFilename(), "document.md");
      assert.equal(await readFile(await saved.path(), "utf8"), markdown);
      assert.deepEqual(
        await api("/api/project-document-tree?project=" + project.id),
        treeBefore,
        "Bot output must not archive into a project",
      );
      assert.equal((await api("/api/bots/queue")).total ?? 0, 0);
      if (locale === "en") {
        await plus.click();
        await page.evaluate(() => window.__pandaForceI18n.setPreference("zh-TW"));
        await page.waitForFunction(() => document.documentElement.lang === "zh-TW");
        assert.match(await page.locator(".composer-add-menu[open] h2").innerText(), /加入/);
        await page.keyboard.press("Escape");
      }
      await page.screenshot({ path: `${out}/reply-${locale}-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        theme,
        uploads: "passed",
        pinnedProjectCopy: "passed",
        skills: "passed",
        recovery: "passed",
        downloadWithoutArchive: "passed",
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(`${out}/verification.json`, JSON.stringify(records, null, 2));
} finally {
  await app.dispose();
}
