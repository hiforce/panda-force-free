import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir as createDirectory } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_FORCE_MEMORY_BACKFILL_PROOF || ".artifacts/project-memory-backfill";
await createDirectory(output, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  completedTurnNotifications: true,
  extraEnvironment({ dir }) {
    const accountHome = join(dir, "grok-account");
    mkdirSync(accountHome, { recursive: true });
    writeFileSync(join(accountHome, "auth.json"), JSON.stringify({ fixture: { access_token: "fixture-only" } }));
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-local",
          name: "Grok Local",
          command: resolve("tests/support/grok-acp-fixture.mjs"),
          accountHome,
        },
      ]),
    };
  },
});
const cases = [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
  [webkit, 390, "zh-HK"],
  [webkit, 320, "zh-TW"],
];
try {
  for (const [engine, width, locale] of cases) {
    const browser = await engine.launch();
    let page;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 840 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
        timezoneId: locale === "en" ? "America/New_York" : "Asia/Shanghai",
      });
      await app.signIn(context);
      await context.addInitScript((language) => {
        if (window === window.top) {
          localStorage.setItem("panda-force-locale", language);
          localStorage.setItem("panda-force-theme", language === "zh-CN" || language === "zh-HK" ? "light" : "aurora");
        }
      }, locale);
      const api = async (path, method = "GET", data) => {
        const response = await context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects");
      const code = "backfill-fixture-" + locale.toLowerCase();
      const project = (
        await api("/api/projects", "POST", {
          name: "Atlas Web",
          code,
          revision: catalog.revision,
          operationId: crypto.randomUUID(),
        })
      ).projects.find((item) => item.code === code);
      assert(project);
      const sessions = "/api/personal/harness/conversations";
      const conversation = (await api(sessions, "POST", { runtimeId: "grok-local" })).conversation;
      const path = sessions + "/" + conversation.id;
      const backfill = path + "/memory-backfill";
      const memory = "/api/projects/" + project.id + "/memory";
      const send = async (text) => {
        await api(path + "/runs", "POST", { requestId: crypto.randomUUID(), text });
        await waitFor(async () => (await api(path)).run?.status === "complete");
      };
      await send("Project convention [release]: prelink example = excluded value");
      const unbound = await context.request.get(app.base + backfill);
      assert.equal(unbound.status(), 404);
      await api("/api/projects/assign", "POST", {
        projectId: project.id,
        sessionIds: ["harness:" + conversation.id],
        revision: (await api("/api/projects")).revision,
      });
      await send("Project convention [release]: deployment window = Monday morning");
      assert.deepEqual((await api(path + "/memory")).contributions.entries, []);
      page = await context.newPage();
      await page.goto(app.base + "/task/harness:" + conversation.id);
      const sessionActions = page.locator("#sessionActionsButton");
      const localized = (key) => page.evaluate((key) => globalThis[Symbol.for("PandaForce.browserI18n")].t(key), key);
      const open = async () => {
        await sessionActions.click();
        await page.locator('#sessionMemoryActions [data-session-action="memory-details"]').click();
        const dialog = page.locator("#sessionMemoryDialog");
        await dialog.waitFor();
        return dialog;
      };
      let dialog = await open();
      let section = dialog.locator("[data-memory-backfill]");
      await section.locator("summary").press("Enter");
      await section.getByText(await localized("sessions.memoryBackfillWriteDisabled"), { exact: true }).waitFor();
      assert.equal(await section.locator("form").isVisible(), false);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      if (await page.locator("#sessionActionsDialog").isVisible()) await page.keyboard.press("Escape");
      await api(memory + "-policy", "PATCH", { revision: 0, write: true, recall: true });
      dialog = await open();
      section = dialog.locator("[data-memory-backfill]");
      assert.equal(await section.locator("summary").textContent(), await localized("sessions.memoryBackfill"));
      await section.locator("summary").click();
      const form = section.locator("form");
      await form.waitFor();
      const today = await form.locator('[name="through"]').getAttribute("max");
      assert(today);
      await form.locator('[name="from"]').fill(today);
      await form.locator('[name="through"]').fill(today);
      const submit = form.locator('button[type="submit"]');
      if (width < 600) {
        const rects = await form.locator("input").evaluateAll((items) =>
          items.map((item) => {
            const r = item.getBoundingClientRect();
            return { top: r.top, left: r.left, height: r.height, width: r.width };
          }),
        );
        assert(rects[1].top > rects[0].top);
        assert.equal(rects[0].left, rects[1].left);
        assert(rects.every((r) => r.height >= 44));
      }
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: join(output, "history-range-" + locale + ".png") });

      if (locale === "en") {
        const submissions = [];
        await page.route("**/memory-backfill", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          submissions.push(route.request().postDataJSON().requestId);
          if (submissions.length !== 1) return route.continue();
          await route.fetch();
          return route.abort();
        });
        await submit.click();
        await section.getByText(await localized("harness.errorUnavailable"), { exact: true }).waitFor();
        assert.equal(await form.locator('[name="from"]').inputValue(), today);
        await submit.click();
        await waitFor(() => submissions.length === 2);
        assert.equal(submissions[0], submissions[1]);
        await page.unroute("**/memory-backfill");
      } else {
        await submit.click();
      }
      await section.locator(".session-memory-backfill-progress:not([hidden])").waitFor();
      if (locale === "zh-TW") {
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        if (await page.locator("#sessionActionsDialog").isVisible()) await page.keyboard.press("Escape");
        // A reopened dialog can start with the old contribution snapshot before reading a completed task.
        const detailURL = "**" + path + "/memory";
        let initialRead = true;
        const stale = { contributions: { entries: [], pending: 0, failed: 0 }, recalls: [] };
        await page.route(detailURL, async (route) => {
          if (!initialRead) return route.continue();
          initialRead = false;
          return route.fulfill({ json: stale });
        });
        await waitFor(async () => (await api(backfill)).task?.state === "complete");
        dialog = await open();
        await dialog.locator("[data-memory-contribution-results]").waitFor();
        await page.unroute(detailURL);
        section = dialog.locator("[data-memory-backfill]");
        await section.locator("summary").click();
        await section.locator(".session-memory-backfill-progress:not([hidden])").waitFor();
        assert.equal(await section.locator('[name="from"]').inputValue(), today);
      }
      await waitFor(async () => (await api(backfill)).task?.state === "complete");
      await dialog.locator("[data-memory-contribution-results]").getByText("Monday morning", { exact: true }).waitFor();
      assert.equal(await section.locator("progress").evaluate((element) => element.value), 100);
      assert.equal((await api(backfill)).task.added, 1);
      assert.deepEqual(
        (await api(path + "/memory")).contributions.entries.map(({ key }) => key),
        ["deployment-window"],
      );
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth));
      const sourceLink = dialog.locator("[data-memory-contribution-results] a");
      await page.screenshot({ path: join(output, "history-completed-" + locale + ".png") });
      await sourceLink.click();
      await page
        .locator("[data-memory-original] .memory-source-body")
        .getByText("Monday morning", { exact: false })
        .waitFor();
      if (locale === "en") {
        await waitFor(async () => (await api(memory)).index.state === "ready").catch(async (error) => {
          console.error("Backfill search index", (await api(memory)).index);
          throw error;
        });
        const target = (await api(sessions, "POST", { runtimeId: "codex", projectId: project.id })).conversation;
        const targetPath = sessions + "/" + target.id;
        await api(targetPath + "/runs", "POST", {
          requestId: crypto.randomUUID(),
          text: "When is the release deployment window?",
        });
        await waitFor(async () => (await api(targetPath)).run?.status === "complete").catch(async (error) => {
          console.error("Recall target run", (await api(targetPath)).run?.status);
          throw error;
        });
        assert(
          (await api(targetPath + "/memory")).recalls.some(
            (recall) =>
              recall.status === "sent" &&
              recall.references.some((ref) => ref.sources.some((source) => source.conversationId === conversation.id)),
          ),
        );
        const current = await api(path + "/memory-policy");
        const impact = await api(path + "/memory-removal-impact");
        await api(path + "/memory-policy", "PATCH", {
          revision: current.source.revision,
          write: null,
          recall: null,
          revoke: true,
          impactToken: impact.token,
        });
        assert.deepEqual((await api(path + "/memory")).contributions.entries, []);
        const task = await api(backfill, "POST", {
          from: Date.now() - 3600000,
          to: Date.now() + 3600000,
          requestId: crypto.randomUUID(),
        });
        assert.equal(task.added, 0);
      }
    } catch (error) {
      if (page) await page.screenshot({ path: join(output, "history-error-" + locale + ".png") }).catch(() => {});
      throw error;
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Explicit rules-only history scans, recovered submissions and original citations passed on desktop and H5.",
  );
} finally {
  await app.dispose();
}
