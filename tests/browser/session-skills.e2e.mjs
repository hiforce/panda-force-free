import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { sessionSkillsFromInput } from "../../src/shared/session-skills.ts";

const out = ".artifacts/session-skills";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  nativeInputHistory: true,
  models: [
    {
      id: "fixture",
      model: "fixture",
      displayName: "Fixture",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      defaultReasoningEffort: "medium",
    },
  ],
});
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1600, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.request.post(app.base + "/api/system/database/selection", {
        headers: { Origin: app.base },
        data: { driver: "sqlite" },
      });
      await context.addInitScript((locale) => {
        if (window === top && /^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      }, locale);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/task/old-alpha");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          globalThis.__pandaForceDebug?.state.active?.id === "old-alpha" &&
          globalThis.__pandaForceDebug.state.models.length > 0,
      );
      await page.locator("[data-session-skills]").click();
      const picker = page.locator(".creation-skill-browser[open]");
      await picker.locator("[data-skill-id=software-prd]").click();
      await picker.locator("footer [data-skill-browser-close]").click();
      await page.locator("#composerSkills [data-selected-skill=software-prd] .template-cover").waitFor();
      await page.locator("#prompt").fill("Create the requirements in docs/prd/requirements.md");
      if (locale === "en")
        await page.route("**/api/conversation-skills/capture", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          await route.continue();
        });
      const before = app.calls().length;
      await page.locator("#composer").evaluate((form) => {
        form.requestSubmit();
        form.requestSubmit();
      });
      if (locale === "en")
        await page.locator("#prompt").fill("Keep this next-message draft while the current request is preparing");
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".user-message-skills")].some((n) => n.textContent.trim()),
      );
      await page.waitForTimeout(300);
      const turns = app
        .calls()
        .slice(before)
        .filter((call) => ["turn/start", "turn/steer"].includes(call.method));
      assert.equal(turns.length, 1, "Repeated submit must coalesce before skill capture and native dispatch");
      const sent = sessionSkillsFromInput(turns[0].params.input);
      assert.equal(sent[0].selection.id, "software-prd");
      if (locale === "en") {
        assert.equal(
          await page.locator("#prompt").inputValue(),
          "Keep this next-message draft while the current request is preparing",
        );
        await page.locator("#prompt").fill("");
        await page.unroute("**/api/conversation-skills/capture");
      }
      if (locale === "en") {
        const payload = {
          id: crypto.randomUUID(),
          scope: "old-alpha",
          input: "Same source request",
          selections: sent.map((skill) => skill.selection),
        };
        const capture = (data, headers = { Origin: app.base }) =>
          context.request.post(app.base + "/api/conversation-skills/capture", { data, headers });
        const first = await capture(payload);
        assert(first.ok(), await first.text());
        const frozen = await first.json();
        const repeated = await capture(payload);
        assert(repeated.ok());
        assert.deepEqual(await repeated.json(), frozen, "A repeated capture preserves the frozen selection");
        assert.equal((await capture({ ...payload, input: "A different request" })).status(), 409);
        assert(
          [401, 403].includes(
            (await capture({ ...payload, id: crypto.randomUUID() }, { Origin: "https://other.example" })).status(),
          ),
        );
        assert.equal(
          (
            await capture({
              ...payload,
              id: crypto.randomUUID(),
              selections: [{ ...sent[0].selection, digest: "0".repeat(64) }],
            })
          ).status(),
          409,
        );
      }
      assert(turns[0].params.input.some((part) => part.text?.includes("docs/prd/requirements.md")));
      assert.equal(
        await page.locator(".user-message").last().innerText(),
        "Create the requirements in docs/prd/requirements.md",
      );
      await page.locator('#composerSkills [data-skill-action="remove"]').click();
      await page.reload();
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          globalThis.__pandaForceDebug?.state.active?.id === "old-alpha" &&
          globalThis.__pandaForceDebug.state.models.length > 0,
      );
      assert.equal(
        await page.locator("#composerSkills [data-selected-skill]").count(),
        0,
        "Removing all skills survives reload",
      );
      assert((await page.locator(".user-message-skills").count()) > 0, "History keeps earlier skill snapshots");
      await page.locator("#prompt").fill("Polish the introduction without the earlier template");
      const next = app.calls().length;
      await page.locator("#composer").evaluate((form) => form.requestSubmit());
      await page.waitForTimeout(400);
      const followup = app
        .calls()
        .slice(next)
        .find((call) => ["turn/start", "turn/steer"].includes(call.method));
      assert(followup);
      assert.deepEqual(sessionSkillsFromInput(followup.params.input), []);
      assert.equal(sent[0].selection.id, "software-prd", "An old request is immutable after picker edits");
      await page.locator("[data-session-skills]").click();
      await picker.locator("[data-skill-id=software-prd]").click();
      await picker.locator("footer [data-skill-browser-close]").click();
      await page.locator("#prompt").fill("A draft retained while the input is folded");
      const selectedCard = await page.locator("#composerSkills [data-selected-skill]").elementHandle();
      const fold = page.locator("#composer .message-composer-disclosure");
      await fold.click();
      assert.equal(await fold.getAttribute("aria-expanded"), "false");
      assert((await page.locator("#composer").boundingBox()).height <= 54);
      assert(await selectedCard.evaluate((node) => node.isConnected), "Collapse preserves skill element identity");
      await page.waitForTimeout(2100);
      assert.equal(await fold.getAttribute("aria-expanded"), "false", "Background updates do not expand the input");
      await page.screenshot({ path: `${out}/collapsed-${width}-${locale}.png` });
      await page.reload();
      await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id === "old-alpha");
      assert.equal(await fold.getAttribute("aria-expanded"), "false", "Fold preference survives reload");
      assert.equal(await page.locator("#prompt").inputValue(), "A draft retained while the input is folded");
      await fold.click();
      assert.equal(await fold.getAttribute("aria-expanded"), "true");
      assert.equal(await page.evaluate(() => document.activeElement.id), "prompt");
      await page.locator("#composerSkills [data-selected-skill] .template-cover").waitFor();
      await page.locator("#prompt").fill("");
      const geometry = await page.locator("#composer").evaluate((form) => ({
        height: form.getBoundingClientRect().height,
        input: form.querySelector("textarea").getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        radius: getComputedStyle(form).borderRadius,
        controls: [...form.querySelectorAll(".composer-footer button")]
          .filter((button) => button.getClientRects().length && !button.closest("[hidden]"))
          .map((button) => {
            const rect = button.getBoundingClientRect(),
              bounds = form.getBoundingClientRect();
            return {
              left: rect.left - bounds.left,
              right: rect.right - bounds.left,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              inside: rect.left >= bounds.left && rect.right <= bounds.right,
            };
          }),
      }));
      assert(!geometry.overflow);
      assert(
        geometry.controls.every((button) => button.inside),
        "Every visible toolbar control stays inside the composer",
      );
      for (const [i, a] of geometry.controls.entries())
        for (const b of geometry.controls.slice(i + 1)) {
          assert(
            Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 ||
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1,
            "Toolbar controls must not overlap",
          );
        }
      assert(geometry.input >= (width < 768 ? 104 : 128));
      await page.screenshot({ path: `${out}/composer-${width}-${locale}.png` });
      const other = locale === "en" ? "zh-TW" : "en";
      await page.evaluate((value) => window.__pandaForceI18n.setPreference(value), other);
      await page.waitForFunction((value) => document.documentElement.lang === value, other);
      assert.match(await page.locator("[data-session-skills]").innerText(), other === "en" ? /Add skill/ : /加入技能/);
      assert.match(
        await page.locator("#composerSkills strong").innerText(),
        other === "en" ? /Software PRD/ : /軟體需求 PRD/,
      );
      assert.match(
        await page.locator(".user-message-skills").first().innerText(),
        other === "en" ? /Software PRD/ : /軟體需求 PRD/,
      );
      if (width === 430) {
        await page.evaluate((value) => window.__pandaForceI18n.setPreference(value), locale);
        await page.locator("[data-session-skills]").click();
        for (const id of ["technical-proposal", "api-contract", "longform-editor", "meeting-notes", "release-notes"])
          await picker.locator(`[data-skill-id="${id}"]`).click();
        await picker.locator("footer [data-skill-browser-close]").click();
        await page.locator("#attachmentInput").setInputFiles(
          Array.from({ length: 6 }, (_, i) => ({
            name: `material-${i + 1}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from(`Material ${i + 1}`),
          })),
        );
        await page.waitForFunction(
          () =>
            globalThis.__pandaForceDebug.state.composerAttachments.length === 6 &&
            globalThis.__pandaForceDebug.state.composerAttachments.every((a) => a.status === "ready"),
        );
        assert.equal(await page.locator("#composerSkills [data-selected-skill]").count(), 6);
        assert(
          (await page.locator("#composer").boundingBox()).height <= geometry.height + 20,
          "Many files and skills must not grow the H5 composer",
        );
        await page.locator('[data-manage-composer-context="files"]').click();
        const manager = page.locator(".message-composer-context-dialog[open]");
        assert.equal(await manager.locator(".composer-attachment").count(), 6);
        await page.screenshot({ path: `${out}/many-files-manager-h5.png` });
        await manager.locator(".composer-attachment-remove").first().click();
        assert.equal(await manager.locator(".composer-attachment").count(), 5);
        await manager.locator("header button").click();
        assert.equal(await page.locator("#composer #composerAttachments .composer-attachment").count(), 5);
        await page.locator('[data-manage-composer-context="skills"]').click();
        await picker.locator('[data-skill-id="technical-proposal"]').click();
        await picker.locator("footer [data-skill-browser-close]").click();
        assert.equal(await page.locator("#composerSkills [data-selected-skill]").count(), 5);
        await page.screenshot({ path: `${out}/many-contexts-h5.png` });
        await page.setViewportSize({ width, height: 500 });
        assert((await page.locator("#composer").boundingBox()).height < 300);
        assert((await page.locator("#conversation").boundingBox()).height > 0);
        await page.screenshot({ path: `${out}/many-contexts-short-h5.png` });
        await page.locator("[data-session-skills]").click();
        for (const id of ["api-contract", "longform-editor", "meeting-notes", "release-notes"])
          await picker.locator(`[data-skill-id="${id}"]`).click();
        await picker.locator("footer [data-skill-browser-close]").click();
        await page.locator("#composerSkills [data-selected-skill=software-prd] .template-cover").waitFor();
        assert.equal(await page.locator("#composerSkills [data-selected-skill]").count(), 1);
        assert.equal(await page.locator("#composerAttachments .composer-attachment").count(), 5);
        await page.screenshot({ path: `${out}/single-skill-many-files-short-h5.png` });
      }
      assert.deepEqual(errors, []);
      records.push({
        width,
        locale,
        ...geometry,
        originalSkillPicker: true,
        nativeSubmission: true,
        removalRetained: true,
        historicalSnapshot: true,
        repeatedSubmitCoalesced: true,
        boundedContextManagement: width === 430,
        foldingRetainsDraftAndSkills: true,
        foldingSurvivesPollingAndReload: true,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(out + "/results.json", JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
