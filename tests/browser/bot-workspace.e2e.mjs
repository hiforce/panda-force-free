import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { BotStore } from "../../src/server/bots/store.js";

const app = await createAppFixture(),
  out = ".artifacts/bot-workspace-redesign/screens",
  records = [];
await mkdir(out, { recursive: true });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
    [webkit, 320, "zh-CN", "aurora"],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({ viewport: { width, height: 1050 }, locale });
    try {
      await context.addInitScript((theme) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await app.signIn(context);
      const api = async (path, data, method = data ? "post" : "get") => {
        const response = await context.request[method](app.base + path, { data, headers: { Origin: app.base } });
        assert.ok(response.ok(), path + ":" + (await response.text()));
        return response.json();
      };
      const bot = (
        await api("/api/bots", {
          name: locale === "en" ? "Product quality reviewer" : "商品质量审核",
          code: "workspace-" + width,
          instructions: "Keep product facts intact. Escalate unclear claims for human review.",
          callbackHosts: ["api.example.com"],
          avatar: { type: "icon", icon: "compass", tone: "warning" },
          persona: {
            role: locale === "en" ? "Product facts & quality" : "商品资料与事实核验",
            traits: "Careful and curious",
            voice: "Warm and clear",
            motto: "Details matter.",
          },
        })
      ).bot;
      await api("/api/bots/" + bot.id, { active: false }, "patch");
      const store = new BotStore(join(app.dir, "panda-state/data/bot-tasks.sqlite"));
      const seeded = [];
      try {
        for (const [index, status] of [
          "review",
          "running",
          "queued",
          "kept",
          "discarded",
          "callback_failed",
        ].entries()) {
          const texts = [
            "TEAM VISOR — Lightweight visor with a flexible strap for daily training.",
            "Trail running jacket — Review the waterproofing description.",
            "Everyday essentials — Check the published material composition.",
            "Court performance shoes — Specifications match the source.",
            "Archived product listing — Content is no longer available.",
            "Training shorts — Callback delivery needs attention.",
          ];
          const task = store.submit(
            bot,
            {
              externalTaskId: "product-" + width + "-" + index,
              instructions: "Review the supplied product facts.",
              input: { text: texts[index], images: [] },
            },
            "workspace-" + width + "-" + index,
          ).task;
          task.status = status;
          task.reason =
            status === "review" ? "The comfort claim needs a source. Please review before publishing." : null;
          store.db
            .query("UPDATE bot_tasks SET status=?,data=?,leaseUntil=? WHERE id=?")
            .run(status, JSON.stringify(task), Date.now() + 600000, task.id);
          seeded.push(task);
        }
      } finally {
        store.close();
      }
      const page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/bots/tasks");
      await page.locator(`[data-detail="${seeded[0].id}"]`).waitFor();
      assert.equal(
        await page.locator('.workbench-navigation > [data-route="workspace"] + [data-route="bots"]').count(),
        1,
      );
      assert.equal(await page.locator(".bot-heading h1").innerText(), locale === "en" ? "Bots" : "助理");
      assert.equal(await page.locator('[data-tab="bots"]').count(), 0);
      assert.equal(
        await page.locator(".bot-metrics").evaluate((el) => getComputedStyle(el).display),
        width < 768 ? "grid" : "flex",
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, "tasks-" + width + ".png") });
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/bots/queue?") && r.url().includes("filter=attention")),
        page.locator('[data-queue-filter="attention"]').click(),
      ]);
      await page.waitForFunction(
        (count) => document.querySelectorAll(".bot-task-row").length === count,
        (records.length + 1) * 2,
      );
      assert.equal(await page.locator(".bot-task-row").count(), (records.length + 1) * 2);
      const search = page.locator("[data-bot-search]");
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/bots/queue?") && r.url().includes("TEAM+VISOR")),
        search.fill("TEAM VISOR"),
      ]);
      await page.waitForFunction(
        (count) => document.querySelectorAll(".bot-task-row").length === count,
        records.length + 1,
      );
      const matchedCount = await page.locator(".bot-task-row").count();
      await search.evaluate((el) => {
        el.dataset.identity = "retained";
        dispatchEvent(new PopStateEvent("popstate"));
      });
      assert.equal(await search.inputValue(), "TEAM VISOR");
      assert.equal(await search.getAttribute("data-identity"), "retained");
      assert.equal(await page.locator(".bot-task-row").count(), matchedCount);
      await page.locator(`[data-detail="${seeded[0].id}"]`).click();
      const detail = page.locator("dialog.bot-detail[open]");
      await detail.waitFor();
      assert.equal(await detail.locator('[data-action="discard"],[data-action="keep"]').count(), 0);
      assert.equal(await detail.locator('[name="pf-bot-review-message"]').isEnabled(), true);
      assert.equal(await detail.locator("[data-bot-review-submit]").isEnabled(), true);
      await page.screenshot({ path: join(out, "detail-" + width + ".png") });
      await page.keyboard.press("Escape");
      await detail.waitFor({ state: "detached" });
      await page.waitForFunction((id) => document.activeElement?.dataset.detail === id, seeded[0].id);
      await page.locator('a[href="/settings/bots"]').first().click();
      await page.locator("[data-new-bot]").waitFor();
      assert.equal(await page.locator("[data-create-bot]").count(), 0);
      assert.equal(await page.locator(".settings-page [data-filter]").count(), 0);
      const row = page.locator(".bot-config-row").filter({ hasText: bot.code });
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale),
        locale === "en" ? "zh-CN" : "en",
      );
      await row.filter({ hasText: locale === "en" ? "跟随引擎默认模型" : "Engine default" }).waitFor();
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      await row.filter({ hasText: locale === "en" ? "Engine default" : "跟随引擎默认模型" }).waitFor();
      await page.screenshot({ path: join(out, "settings-" + width + ".png") });
      await page.locator("[data-new-bot]").click();
      const dialog = page.locator("dialog.bot-dialog[open]"),
        name = dialog.locator('[name="pf-bot-name"]');
      assert.equal(await dialog.locator('[data-avatar-icon="panda"]').getAttribute("aria-pressed"), "true");
      const palette = [];
      for (const appearance of ["silk", "aurora"]) {
        await page.evaluate((appearance) => {
          document.documentElement.dataset.appearance = appearance;
        }, appearance);
        const colors = await dialog.evaluate((root) => {
          const avatar = root.querySelector("[data-profile-preview] > .bot-avatar"),
            svg = avatar.querySelector(".bot-panda-symbol");
          return {
            ink: getComputedStyle(svg.querySelector("circle")).fill,
            accent: getComputedStyle(avatar).color,
            face: getComputedStyle(svg.querySelector("path")).fill,
            panel: getComputedStyle(avatar).backgroundColor,
            flame: getComputedStyle(svg.querySelectorAll("path")[2]).fill,
            text: getComputedStyle(root).color,
          };
        });
        assert.equal(colors.ink, colors.accent, "Mascot ears and eyes follow the selected theme or avatar tone");
        assert.equal(colors.face, colors.panel, "Mascot face follows the panel palette");
        assert.equal(colors.flame, colors.text, "Mascot flame follows the theme's contrasting ink");
        palette.push(colors);
        await page.screenshot({ path: join(out, `avatar-panda-${width}-${appearance}.png`) });
      }
      assert.notEqual(palette[0].ink, palette[1].ink, "Mascot must change with the active theme without reloading");
      await page.evaluate((theme) => {
        document.documentElement.dataset.appearance = theme;
      }, theme);
      for (const icon of ["panda", "cat", "dog", "fox", "owl", "rabbit", "bear", "tiger", "penguin"]) {
        await dialog.locator(`[data-avatar-icon="${icon}"]`).click();
        const geometry = await dialog.evaluate((root) => {
          const box = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          const avatar = root.querySelector("[data-profile-preview] > .bot-avatar");
          return {
            preview: box(avatar),
            previewSvg: box(avatar.querySelector("svg")),
            choices: [...root.querySelectorAll("[data-avatar-icon]")].map((button) => ({
              button: box(button),
              avatar: box(button.querySelector(".bot-avatar")),
              svg: box(button.querySelector("svg")),
            })),
          };
        });
        await page.screenshot({ path: join(out, "avatar-alignment-" + width + ".png") });
        const centered = (outer, inner) =>
          Math.abs(outer.x + outer.width / 2 - inner.x - inner.width / 2) <= 0.5 &&
          Math.abs(outer.y + outer.height / 2 - inner.y - inner.height / 2) <= 0.5;
        assert.ok(
          centered(geometry.preview, geometry.previewSvg),
          `Preview ${icon} must be centered: ${JSON.stringify(geometry)}`,
        );
        for (const choice of geometry.choices) {
          assert.ok(Math.abs(choice.button.width - choice.button.height) <= 0.5, "Avatar controls must be square");
          assert.ok(
            choice.button.width >= 44 && choice.button.height >= 44,
            "Avatar controls must retain touch targets",
          );
          assert.ok(
            centered(choice.button, choice.avatar) && centered(choice.avatar, choice.svg),
            `Avatar border, background and SVG must share one center: ${JSON.stringify(choice)}`,
          );
        }
      }
      await dialog.locator('[data-avatar-icon="fox"]').click();
      const animalPalette = [];
      for (const appearance of ["silk", "aurora"]) {
        await page.evaluate((appearance) => (document.documentElement.dataset.appearance = appearance), appearance);
        for (const tone of ["accent", "success", "warning"]) {
          await dialog.locator(`[data-avatar-tone-choice="${tone}"]`).click();
          const paint = await dialog.evaluate((root) => {
            const avatar = root.querySelector("[data-profile-preview] > .bot-avatar"),
              svg = avatar.querySelector(".bot-animal-symbol");
            return {
              color: getComputedStyle(svg).color,
              fur: getComputedStyle(svg.querySelector("path")).fill,
              face: getComputedStyle(svg).getPropertyValue("--bot-animal-face").trim(),
              icon: avatar.getAttribute("data-avatar-tone"),
            };
          });
          assert.equal(paint.icon, tone);
          assert.equal(paint.fur, paint.color, "Animal fur follows the selected semantic avatar color");
          animalPalette.push({ appearance, tone, ...paint });
          await page.screenshot({ path: join(out, `animal-palette-${width}-${appearance}-${tone}.png`) });
        }
      }
      assert.notEqual(animalPalette[0].color, animalPalette[1].color);
      assert.notEqual(animalPalette[0].face, animalPalette[3].face);
      await page.evaluate((appearance) => (document.documentElement.dataset.appearance = appearance), theme);
      await name.fill(locale === "en" ? "Catalog editor" : "商品资料助理");
      await dialog.locator('[name="pf-bot-code"]').fill("created-workspace-" + width);
      await dialog
        .locator('[name="pf-bot-instructions"]')
        .fill("Review descriptions for clarity and factual accuracy.");
      await dialog.locator('[name="pf-bot-role"]').fill(locale === "en" ? "Catalog storyteller" : "商品资料搭档");
      await dialog.locator(".bot-personality summary").click();
      await dialog.locator('[data-persona-preset="2"]').click();
      await dialog
        .locator('[name="pf-bot-motto"]')
        .fill(locale === "en" ? "Facts first. A little spark, always." : "先把事实理清，再添一点灵感。");
      await dialog.locator("[data-avatar-file]").setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: await readFile("public/assets/panda-icon.png"),
      });
      await dialog.locator("[data-profile-preview] img").waitFor();
      await page.waitForFunction(() => document.querySelector("[data-profile-preview] img")?.complete);
      await dialog.locator('[name="pf-bot-name"]').focus();
      const box = await dialog.boundingBox();
      assert.ok(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width + 1 &&
          Math.abs(box.x + box.width / 2 - width / 2) <= 1,
      );
      assert.ok((await dialog.locator('[type="submit"]').evaluate((el) => el.getBoundingClientRect().height)) >= 40);
      await dialog.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({ path: join(out, "create-" + width + ".png") });
      await page.evaluate(
        (locale) => globalThis.__pandaForceI18n.setPreference(locale),
        locale === "en" ? "zh-CN" : "en",
      );
      await dialog
        .locator("[data-cancel-edit]")
        .filter({ hasText: locale === "en" ? "取消" : "Cancel" })
        .waitFor();
      assert.equal(await name.inputValue(), locale === "en" ? "Catalog editor" : "商品资料助理");
      await page.evaluate((locale) => globalThis.__pandaForceI18n.setPreference(locale), locale);
      await dialog
        .locator("[data-cancel-edit]")
        .filter({ hasText: locale === "en" ? "Cancel" : "取消" })
        .waitFor();
      await dialog.locator(".bot-personality").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(out, "personality-" + width + ".png") });
      let failed = 0;
      await page.route("**/api/bots", async (route) => {
        if (route.request().method() === "POST" && failed++ === 0)
          await route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        else await route.continue();
      });
      const failure = page.waitForResponse((r) => r.url().endsWith("/api/bots") && r.request().method() === "POST");
      await dialog.locator('[type="submit"]').click();
      assert.equal((await failure).status(), 503);
      await dialog
        .locator("[data-bot-dialog-notice]")
        .filter({ hasText: locale === "en" ? "failed" : "失败" })
        .waitFor();
      const feedback = await dialog.locator("[data-bot-dialog-notice]").boundingBox();
      const visibleDialog = await dialog.boundingBox();
      await page.screenshot({ path: join(out, "save-error-" + width + ".png") });
      assert.ok(
        feedback &&
          visibleDialog &&
          feedback.y >= visibleDialog.y &&
          feedback.y + feedback.height <= visibleDialog.y + visibleDialog.height,
        "Save failure feedback must remain inside the visible dialog after scrolling to Submit",
      );
      assert.equal(await name.inputValue(), locale === "en" ? "Catalog editor" : "商品资料助理");
      await dialog.locator('[type="submit"]:enabled').waitFor();
      const saved = page.waitForResponse((r) => r.url().endsWith("/api/bots") && r.request().method() === "POST");
      await dialog.locator('[type="submit"]').click();
      assert.equal((await saved).status(), 201);
      await dialog.waitFor({ state: "detached" });
      const result = await api("/api/bots");
      assert.equal(result.bots.filter((b) => b.code === "created-workspace-" + width).length, 1);
      const created = result.bots.find((b) => b.code === "created-workspace-" + width);
      assert.equal(created.avatar.type, "image");
      assert.equal(created.persona.role, locale === "en" ? "Catalog storyteller" : "商品资料搭档");
      assert.ok(created.persona.traits.length > 20);
      const avatarPath = "/api/bots/avatars/" + created.avatar.id;
      assert.equal((await context.request.get(app.base + avatarPath)).headers()["content-type"], "image/webp");
      assert.equal((await fetch(app.base + avatarPath)).status, 401);
      await page.screenshot({ path: join(out, "settings-saved-" + width + ".png") });

      await page.locator('[data-tab="keys"]').click();
      await page.locator("[data-issue-key]").click();
      const keyDialog = page.locator("dialog.bot-dialog[open]");
      await keyDialog.locator('[name="pf-bot-name"]').fill("Product integration");
      await keyDialog.locator(`[name="pf-bot-bot"][value="${bot.id}"]`).check();
      await keyDialog.locator('[type="submit"]').click();
      await keyDialog.locator("[data-key]").waitFor();
      await page.waitForFunction(() => document.querySelector("dialog.bot-dialog[open]")?.dataset.pending === "false");
      assert.ok((await keyDialog.locator("[data-key]").inputValue()).length > 20);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
        document.execCommand = () => false;
      });
      await keyDialog.locator("[data-copy]").click();
      await keyDialog
        .locator("[data-bot-dialog-notice]")
        .filter({ hasText: locale === "en" ? "manually" : "手动" })
        .waitFor();
      assert.equal(
        await keyDialog
          .locator("[data-key]")
          .evaluate(
            (el) => el === document.activeElement && el.selectionStart === 0 && el.selectionEnd === el.value.length,
          ),
        true,
      );
      await page.keyboard.press("Escape");
      await page.locator("dialog.bot-dialog [data-key]").waitFor({ state: "detached" });
      assert.equal(await page.locator("[data-key]").count(), 0);
      assert.equal(
        await page.locator("#settingsDialog").evaluate((el) => el.open),
        true,
        "Closing a secret dialog must preserve Bot settings",
      );
      await page.locator('a[href="/bots"]').click();
      await page.waitForURL("**/bots");
      await page.locator('a[href="/bots/tasks"]').click();
      await page.locator("[data-bot-task-rows]").waitFor();
      assert.equal(await page.locator("#settingsDialog").evaluate((el) => el.open), false);
      assert.equal(await search.inputValue(), "TEAM VISOR");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        avatarAlignmentAndSquareControlsVerified: true,
        defaultPandaAndLiveThemeColorsVerified: true,
        independentPrimaryNavigation: true,
        configurationSeparated: true,
        taskFilterAndQueryPreserved: true,
        dialogsAndFocusVerified: true,
        failedSavePreservesInputs: true,
        createPersistsOnce: true,
        secretClearedOnClose: true,
        avatarAndPersonaPersist: true,
        avatarRequiresAuthentication: true,
        returnClosesSettings: true,
        noHorizontalOverflow: true,
      });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    join(out, "result.json"),
    JSON.stringify({ passed: true, records, modelInferenceRequested: false }, null, 2) + "\n",
  );
} finally {
  await app.dispose();
}
