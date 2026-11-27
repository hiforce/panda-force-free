import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_MEMORY_MAP_PROOF || ".artifacts/project-memory-map-language";
await mkdir(output, { recursive: true });
const app = await createAppFixture({
  applicationMemory: true,
  completedTurnNotifications: true,
  startupTimeoutMs: 60000,
});
const legacy = "/api/personal/harness/legacy-memory/old-alpha";
const preferences = "/api/personal/harness/memory-preferences";
let project;
const words = {
  "Food preferences": "Likes dumplings and noodles.",
  Profession: "Architecture consultant.",
  Profile: "Based in Taipei.",
};
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
    [chromium, 1366, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 850 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
        reducedMotion: locale === "zh-TW" ? "reduce" : "no-preference",
      });
      await app.signIn(context);
      await context.addInitScript(
        ({ locale, theme }) => {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
        },
        { locale, theme: locale === "zh-HK" ? "aurora" : "light" },
      );
      const request = (path, method = "GET", data) =>
        context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
      const api = async (path, method, data) => {
        const response = await request(path, method, data);
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      if (!project) {
        const { revision } = await api("/api/projects");
        const catalog = await api("/api/projects", "POST", {
          name: "Atlas",
          code: "atlas",
          revision,
          operationId: crypto.randomUUID(),
        });
        project = catalog.projects.find(({ code }) => code === "atlas");
        await api("/api/projects/assign", "POST", {
          projectId: project.id,
          sessionIds: ["old-alpha"],
          revision: catalog.revision,
        });
        const endpoint = "/api/projects/" + project.id;
        const policy = await api(endpoint + "/memory-policy");
        await api(endpoint + "/memory-policy", "PATCH", {
          revision: policy.revision,
          write: true,
          recall: true,
          model: { enabled: true, selection: { runtimeId: "codex", model: "gpt-fixture", effort: "medium" } },
        });
        const sessions = "/api/personal/harness/conversations";
        const { conversation } = await api(sessions, "POST", { runtimeId: "codex", projectId: project.id });
        await api(sessions + "/" + conversation.id + "/runs", "POST", {
          text: "As a Taipei-based architecture consultant, dumplings and noodles are my favorites.",
          requestId: crypto.randomUUID(),
        });
        const session = sessions + "/" + conversation.id;
        await waitFor(async () => (await api(session)).run?.status === "complete");
        await waitFor(
          async () => (await api(endpoint + "/memory-terrain?view=overview")).places.length === 3,
          20000,
        ).catch(async () => {
          const entries = (await api(endpoint + "/memory")).entries.map(({ key }) => key);
          const calls = app
            .calls()
            .slice(-25)
            .map(({ method }) => method);
          throw new Error(
            "Expected three organized map entries. Entries: " +
              JSON.stringify(entries) +
              ". Calls: " +
              JSON.stringify(calls),
          );
        });
      }
      const endpoint = "/api/projects/" + project.id;
      const route = "/project?id=" + encodeURIComponent(project.id) + "&tab=memory";
      const page = await context.newPage();
      page.setDefaultTimeout(25000);
      await page.goto(app.base + route);
      const map = page.locator(".memory-terrain-scene");
      const detail = page.locator("[data-memory-place-detail]");
      const marks = map.locator(".memory-terrain-marker");
      await marks.first().waitFor();
      assert.equal(await marks.count(), 3);
      await map.locator('canvas[data-memory-links="3"]').waitFor();
      const network = await api(endpoint + "/memory-terrain?view=overview");
      assert.deepEqual(network.links.map(({ kind }) => kind).sort(), ["related", "sameSource", "sameSource"]);
      assert.equal(await page.locator("[data-memory-topic]:visible").count(), 0);
      assert(await page.locator('[data-place-action="practice"] svg').isVisible());
      const positions = await marks.evaluateAll((buttons) =>
        buttons.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
      for (let i = 0; i < positions.length; i++) {
        const a = positions[i];
        assert(a.width >= 44 && a.height >= 44);
        for (const b of positions.slice(i + 1))
          assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(output, "overview-" + locale + ".png") });
      const food = map.getByRole("button", { name: "Food preferences", exact: true });
      await food.press("Enter");
      assert.equal(await food.getAttribute("aria-pressed"), "true");
      await detail.getByText(words["Food preferences"], { exact: true }).waitFor();
      assert.equal(await map.locator("canvas").getAttribute("data-memory-active-links"), "2");
      if (locale === "zh-TW") {
        assert(
          await map.locator("canvas").evaluate(async (canvas) => {
            const before = canvas.toDataURL();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return before === canvas.toDataURL();
          }),
        );
      }
      const related = detail.locator("[data-memory-related]");
      assert.equal(await related.count(), 2);
      const profile = map.getByRole("button", { name: "Profile", exact: true });
      await related.filter({ hasText: "Profile" }).press("Enter");
      await detail.getByText(words.Profile, { exact: true }).waitFor();
      assert(await profile.evaluate((el) => el === document.activeElement));
      await food.press("Enter");
      const practice = page.locator('[data-place-action="practice"]');
      await practice.click();
      assert.equal(await practice.getAttribute("aria-pressed"), "true");
      assert(await practice.locator("svg").isVisible());
      assert.equal(await detail.locator(".memory-place-value").count(), 0);
      await detail.locator('[data-place-action="reveal"]').click();
      await detail.getByText(words["Food preferences"], { exact: true }).waitFor();
      await practice.click();
      await detail.locator('[data-place-action="close-place"]').click();
      assert(await food.evaluate((el) => el === document.activeElement));
      await map.getByRole("button", { name: "Profession", exact: true }).click();
      await detail.getByText(words.Profession, { exact: true }).waitFor();
      const selectedLink = page.url();
      await page.reload();
      await detail.getByText(words.Profession, { exact: true }).waitFor();
      assert.equal(page.url(), selectedLink);
      await page.screenshot({ path: join(output, "detail-" + locale + ".png") });

      if (locale === "en") {
        await page.goto(app.base + "/settings/general-settings");
        const system = page.locator("[data-memory-system-language]");
        await system.locator("[data-memory-language]:enabled").waitFor();
        assert.equal(await system.locator("[data-memory-language]").inputValue(), "en");
        assert((await system.locator("option").count()) > 150);
        await system.locator("[data-memory-language-search-options] summary").click();
        await system.locator("[data-memory-language-search]").fill("Japanese");
        await system.locator("[data-memory-language]").selectOption("ja");
        await system.locator("[data-memory-language-save]").click();
        await waitFor(async () => (await api(preferences)).language === "ja");
        assert.equal(await page.locator("#languageSelect").inputValue(), "en");
        assert.equal((await request(preferences, "PATCH", { revision: 0, language: "fr" })).status(), 409);
        assert.equal((await request(preferences, "PATCH", { revision: 1, language: "<bad>" })).status(), 400);
        await page.locator('[data-preference-section="region"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, "general-en.png") });

        await page.goto(app.base + route);
        await page.locator('.project-memory-view a[href^="/settings/memory-settings"]').click();
        const projectForm = page.locator("[data-memory-project-language]");
        const projectPicker = projectForm.locator("[data-memory-language]");
        await projectPicker.waitFor();
        await waitFor(async () => (await projectPicker.inputValue()) === "inherit");
        assert((await projectPicker.locator("option:checked").textContent()).includes("Japanese"));
        await projectForm.locator("[data-memory-language-search-options] summary").click();
        await projectForm.locator("[data-memory-language-search]").fill("es-MX");
        await projectPicker.selectOption("es-MX");
        await projectForm.locator("[data-memory-language-save]").click();
        await waitFor(async () => (await api(endpoint + "/memory-language")).language === "es-MX");
        await page.screenshot({ path: join(output, "project-en.png") });

        const policy = await api(endpoint + "/memory-policy");
        await api(endpoint + "/memory-policy", "PATCH", {
          revision: policy.revision,
          write: true,
          recall: true,
          model: {
            enabled: true,
            selection: { runtimeId: "codex", model: "gpt-fixture", effort: "medium" },
          },
        });
        const sessions = "/api/personal/harness/conversations";
        const { conversation } = await api(sessions, "POST", { runtimeId: "codex", projectId: project.id });
        const send = async (text) => {
          await api(sessions + "/" + conversation.id + "/runs", "POST", { text, requestId: crypto.randomUUID() });
          await waitFor(async () => (await api(sessions + "/" + conversation.id)).run?.status === "complete");
        };
        const record = async (title) => {
          let entry;
          await waitFor(async () => {
            entry = (await api(endpoint + "/memory")).entries.find((item) => item.title === title);
            return !!entry;
          }, 20000);
          return entry;
        };
        await send("Confirmed in English: the cache lasts twenty-four hours.");
        const spanish = await record("Duración de la caché");
        assert.equal(spanish.value, "Veinticuatro horas");
        await projectPicker.selectOption("inherit");
        await projectForm.locator("[data-memory-language-save]").click();
        await waitFor(async () => (await api(endpoint + "/memory-language")).language === null);
        await send("This specific cache retention is twenty-four hours.");
        assert.equal((await record("キャッシュ保持時間")).value, "24時間");
        const source = spanish.sources[0];
        const sourceQuery = new URLSearchParams({ conversation: source.conversationId, message: source.messageId });
        assert.equal(
          (await api(endpoint + "/memory-source?" + sourceQuery)).text,
          "Confirmed in English: the cache lasts twenty-four hours.",
        );
        const result = await api(endpoint + "/memory-terrain?view=overview&place=" + spanish.id);
        assert(result.places.some(({ entry }) => entry.title === "Duración de la caché"));
        await api(endpoint + "/memory-policy", "PATCH", {
          revision: policy.revision + 1,
          write: false,
          recall: false,
          model: { enabled: false, selection: null },
        });
        await api(sessions + "/" + conversation.id, "DELETE", {});
      }

      if (locale === "zh-TW") {
        await page.goto(app.base + "/settings/general-settings");
        const system = page.locator("[data-memory-system-language]");
        const picker = system.locator("[data-memory-language]");
        if (!(await picker.isVisible())) await page.locator('[data-settings-page="general-settings"]:visible').click();
        await picker.waitFor();
        await waitFor(async () => (await picker.inputValue()) === "ja");
        await picker.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, "general-zh-TW.png") });
        await page.goto(app.base + route);
        await api(legacy, "POST", {
          entries: Array.from({ length: 6 }, (_, i) => ({ key: "other-convention-" + i, value: "Fixture rule " + i })),
        });
        await api(legacy, "POST", {
          entries: [{ key: "user-profession", scope: "mobile-team", value: "Mobile design." }],
        });
        await page.reload();
        await marks.first().waitFor();
        assert.equal(await marks.count(), 6);
        const pageOne = await api(endpoint + "/memory-terrain?view=overview");
        assert.equal(pageOne.links.length, 4);
        const [offPage] = pageOne.related;
        assert.equal(offPage.key, "user-profession");
        assert.equal(await map.locator("canvas").getAttribute("data-memory-links"), "3");
        const next = page.locator('[data-place-action="page-next"]');
        const isOverview = (url) => url.searchParams.get("view") === "overview";
        await page.route(
          (url) => url.pathname.endsWith("/memory-terrain") && isOverview(url),
          async (route) => {
            await route.fulfill({
              status: 503,
              body: JSON.stringify({ code: "unavailable", messageId: "harness.errorUnavailable" }),
              contentType: "application/json",
            });
          },
          { times: 1 },
        );
        await next.press("Enter");
        const retry = page.locator('[data-place-action="retry"]');
        await retry.waitFor();
        assert(await retry.evaluate((el) => el === document.activeElement));
        await retry.press("Enter");
        await marks.first().waitFor();
        assert.equal(await marks.count(), 4);
        assert(await page.locator('[data-place-action="page-prev"]').isEnabled());
        assert(await next.isDisabled());
        await page.locator('[data-place-action="page-prev"]').press("Enter");
        await marks.first().waitFor();
        const sameTopic = pageOne.links.find(({ kind }) => kind === "sameTopic");
        const shown = [sameTopic.from, sameTopic.to].find((id) => id !== offPage.id);
        await map.locator('[data-memory-place="' + shown + '"]').press("Enter");
        await detail.locator('[data-memory-related="' + offPage.id + '"]').press("Enter");
        await detail.getByText("Mobile design.", { exact: true }).waitFor();
        assert(
          await map
            .locator('[data-memory-place="' + offPage.id + '"]')
            .evaluate((element) => element === document.activeElement),
        );
        await detail.locator('[data-memory-related="' + shown + '"]').press("Enter");
        await detail.getByText(words.Profession, { exact: true }).waitFor();
        await marks.first().waitFor();
        assert.equal(await marks.count(), 6);
      }
    } finally {
      await browser.close();
    }
  }
  console.log("Project memory overview and inherited memory language passed on desktop and H5 across four locales.");
} finally {
  await app.dispose();
}
