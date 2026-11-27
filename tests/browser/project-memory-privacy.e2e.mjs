import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const proof = process.env.PANDA_FORCE_MEMORY_PRIVACY_PROOF || ".artifacts/project-memory-privacy";
await mkdir(proof, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  completedTurnNotifications: true,
  applicationMemory: true,
});
const sessions = "/api/personal/harness/conversations";
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 840 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((language) => {
        if (window === window.top) {
          localStorage.setItem("panda-force-locale", language);
          localStorage.setItem("panda-force-theme", language === "zh-CN" || language === "zh-TW" ? "aurora" : "light");
        }
      }, locale);
      const api = async (path, method = "GET", data) => {
        const response = await context.request.fetch(app.base + path, {
          method,
          data,
          headers: { Origin: app.base },
        });
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects");
      const code = "memory-privacy-" + locale.toLowerCase();
      const project = (
        await api("/api/projects", "POST", {
          name: "Atlas Web",
          code,
          revision: catalog.revision,
          operationId: crypto.randomUUID(),
        })
      ).projects.find((item) => item.code === code);
      assert(project);
      const projectMemory = "/api/projects/" + project.id + "/memory";
      await api(projectMemory + "-policy", "PATCH", {
        revision: 0,
        write: true,
        recall: true,
        model: { enabled: true, selection: { runtimeId: "codex", model: "gpt-fixture", effort: "medium" } },
      });
      const page = await context.newPage();
      const localized = (key) => page.evaluate((key) => globalThis[Symbol.for("PandaForce.browserI18n")].t(key), key);
      const openInspector = async () => {
        const visible = page.locator("#sessionInfoButton");
        const mobile = page.locator("#sessionMobileSummary [data-session-action=open]");
        await waitFor(async () => (await visible.isVisible()) || (await mobile.isVisible()));
        await ((await visible.isVisible()) ? visible : mobile).click();
        await page.locator("#sessionInspector").waitFor();
      };

      await page.goto(app.base + "/new?project=" + project.id);
      const mode = page.locator(".composer-memory-mode");
      await mode.waitFor();
      const privacy = mode.getByRole("switch", { name: await localized("sessions.memoryModePrivate"), exact: true });
      const mobile = width < 600;
      const toggle = () => (mobile ? privacy.tap() : privacy.press("Space"));
      assert.equal(await privacy.getAttribute("aria-checked"), "false");
      assert.equal(await privacy.getAttribute("aria-describedby"), null);
      const label = privacy.locator(".composer-private-label");
      assert(await label.isVisible());
      const lock = privacy.locator(".icon-slot > svg");
      const track = privacy.locator(".pf-switch-track");
      const target = await privacy.boundingBox();
      assert(target.height >= (mobile ? 44 : 40) && target.width >= 44);
      const visibleParts = [track, lock, label];
      let right = target.x;
      for (const part of visibleParts) {
        const box = await part.boundingBox();
        assert(box && box.x >= right, "Expected the switch, lock and label in reading order");
        assert(
          Math.abs(box.y + box.height / 2 - (target.y + target.height / 2)) <= 0.5,
          "Expected a common horizontal centerline",
        );
        right = box.x + box.width;
      }
      await page.locator("#composer").screenshot({ path: join(proof, "privacy-off-" + locale + ".png") });
      const off = await track.evaluate((element) => getComputedStyle(element).backgroundColor);
      await toggle();
      assert.equal(await privacy.getAttribute("aria-checked"), "true");
      assert.equal(await privacy.getAttribute("aria-describedby"), "privateSessionHint");
      assert.notEqual(await track.evaluate((element) => getComputedStyle(element).backgroundColor), off);
      // Changing workspaces through the SPA abandons the scoped creation option.
      const navigate = (url) =>
        page.evaluate((url) => {
          history.pushState(null, "", url);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, url);
      await navigate("/projects");
      await privacy.waitFor({ state: "hidden" });
      await navigate("/new?project=" + project.id);
      await privacy.waitFor();
      assert.equal(await privacy.getAttribute("aria-checked"), "false");
      await toggle();
      await toggle();
      assert.equal(await privacy.getAttribute("aria-checked"), "false");
      await toggle();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(proof, "private-creation-" + locale + ".png") });
      const created = page.waitForResponse((response) => {
        return new URL(response.url()).pathname === sessions && response.request().method() === "POST";
      });
      await page.locator("#prompt").fill("Project convention [release]: private draft = must stay out");
      await page.locator("#sendButton").click();
      const response = await created;
      assert(response.ok(), await response.text());
      assert.equal(response.request().postDataJSON().memoryPrivate, true);
      const { conversation: privateSession } = await response.json();
      assert.equal(privateSession.memoryPrivate, true);
      assert.equal(privateSession.projectId, project.id);
      const privatePath = sessions + "/" + privateSession.id;
      await waitFor(async () => (await api(privatePath)).run?.status === "complete", 30000);
      await page.waitForURL((url) => url.pathname.startsWith("/task/"), { timeout: 15000 });
      await privacy.waitFor({ state: "hidden" });
      const privateStatus = mode.getByText(await localized("sessions.memoryPrivateActive"), { exact: true });
      await privateStatus.waitFor();
      await page.locator("#composer").screenshot({ path: join(proof, "private-active-" + locale + ".png") });
      await openInspector();
      const control = page.locator("#sessionMemoryControl");
      await control.getByText(await localized("sessions.memoryModePrivate"), { exact: true }).waitFor();
      assert.equal(await control.locator("[data-memory-control-button]").isVisible(), false);
      assert.equal((await context.request.get(app.base + privatePath + "/memory")).status(), 404);
      assert.equal((await context.request.get(app.base + privatePath + "/memory-backfill")).status(), 404);
      const forged = await context.request.patch(app.base + privatePath + "/memory-policy", {
        headers: { Origin: app.base },
        data: { revision: 0, paused: false, write: true, recall: true },
      });
      assert.equal(forged.status(), 404);
      assert.deepEqual((await api(projectMemory)).entries, []);

      await page.goto(app.base + "/new?project=" + project.id);
      await mode.waitFor();
      assert.equal(await privacy.getAttribute("aria-checked"), "false");
      const standardCreated = page.waitForResponse(
        (value) => new URL(value.url()).pathname === sessions && value.request().method() === "POST",
      );
      await page.locator("#prompt").fill("Start the standard conversation.");
      await page.locator("#sendButton").click();
      const standardResponse = await standardCreated;
      assert(standardResponse.ok(), await standardResponse.text());
      const { conversation: standard } = await standardResponse.json();
      assert.equal(standard.projectId, project.id);
      assert.equal(standard.memoryPrivate, undefined);
      const path = sessions + "/" + standard.id;
      await waitFor(async () => (await api(path)).run?.status === "complete", 30000);
      await mode.waitFor({ state: "hidden" });
      const policy = path + "/memory-policy";
      assert.equal((await api(policy)).source.paused, false);
      const send = async (destination, text) => {
        const run = await api(destination + "/runs", "POST", { requestId: crypto.randomUUID(), text });
        await waitFor(async () => (await api(destination)).run?.status === "complete", 30000);
        return run.runId;
      };
      const ask = "What is the release review slot?";
      if (locale === "en") {
        const { conversation: contributor } = await api(sessions, "POST", {
          runtimeId: "codex",
          projectId: project.id,
        });
        await send(sessions + "/" + contributor.id, "Project convention [release]: review slot = Thursday");
        await waitFor(async () => {
          const view = await api(projectMemory);
          return view.entries.length === 1 && view.index.state === "ready";
        }, 60000);
        const issued = await send(path, ask);
        assert(
          (await api(path + "/memory")).recalls.some(({ runId, status }) => runId === issued && status === "sent"),
        );
      }
      await page.goto(app.base + "/task/harness:" + standard.id);
      await openInspector();
      const pause = control.getByRole("button", { name: await localized("sessions.memoryPause"), exact: true });
      if (locale === "en") {
        const endpoint = "**" + policy;
        await page.route(endpoint, async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          await route.fetch();
          return route.abort();
        });
        await pause.click();
        const retry = control.getByRole("button", { name: await localized("common.retry"), exact: true });
        await retry.waitFor();
        assert.equal((await api(policy)).source.paused, true);
        await page.unroute(endpoint);
        await retry.click();
      } else await pause.click();
      await control.getByText(await localized("sessions.memoryInspectorPaused"), { exact: true }).waitFor();
      assert.equal((await api(policy)).source.paused, true);
      assert.equal((await api(path + "/memory-backfill")).availability, "paused");
      if (locale === "en") {
        const withheld = await send(path, ask);
        assert(!(await api(path + "/memory")).recalls.some(({ runId }) => runId === withheld));
        await send(path, "Project convention [release]: pause note = kept out");
        assert.deepEqual((await api(path + "/memory")).contributions.entries, []);
      }
      await page.screenshot({ path: join(proof, "memory-paused-" + locale + ".png") });
      await page.reload();
      await openInspector();
      const resume = control.getByRole("button", { name: await localized("sessions.memoryResume"), exact: true });
      if (width < 600) {
        const target = await resume.boundingBox();
        assert(target.width >= 44 && target.height >= 44);
        assert.equal(await resume.locator("span:not(.icon-slot)").last().isVisible(), false);
      }
      await resume.click();
      await control.getByText(await localized("sessions.memoryInspectorEmpty"), { exact: true }).waitFor();
      assert.equal((await api(policy)).source.paused, false);
      if (locale === "en") {
        await send(path, "Project convention [release]: resume note = retained");
        await waitFor(async () => (await api(path + "/memory")).contributions.entries.length === 1, 60000);
        const backfill = path + "/memory-backfill";
        await api(backfill, "POST", {
          from: Date.now() - 3600000,
          to: Date.now() + 3600000,
          requestId: crypto.randomUUID(),
        });
        await waitFor(async () => (await api(backfill)).task?.state === "complete", 60000);
        assert.deepEqual(
          (await api(path + "/memory")).contributions.entries.map(({ key }) => key),
          ["resume-note"],
        );
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await context.close();
    } finally {
      await browser.close();
    }
  }
  console.log("Private creation and permanent pause ranges passed on desktop and H5.");
} finally {
  await app.dispose();
}
