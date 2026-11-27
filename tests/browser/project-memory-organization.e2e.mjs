import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const screenshots = process.env.PANDA_MEMORY_ORGANIZATION_PROOF || ".artifacts/project-memory-organization";
await mkdir(screenshots, { recursive: true });
const app = await createAppFixture({
  applicationMemory: true,
  completedTurnNotifications: true,
  startupTimeoutMs: 60000,
});
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "en"],
    [chromium, 1440, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 860 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((lang) => localStorage.setItem("panda-force-locale", lang), locale);
      const api = async (path, method = "GET", data) => {
        const result = await context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
        assert(result.ok(), path + " " + result.status() + " " + (await result.text()));
        return result.json();
      };
      const { revision } = await api("/api/projects");
      const code = "memory-" + locale.toLowerCase();
      const project = (
        await api("/api/projects", "POST", {
          name: "Memory " + locale,
          code,
          revision,
          operationId: crypto.randomUUID(),
        })
      ).projects.find((item) => item.code === code);
      const path = "/api/projects/" + project.id;
      const page = await context.newPage();
      page.setDefaultTimeout(22000);
      await page.goto(app.base + "/project?id=" + encodeURIComponent(project.id) + "&tab=memory");
      const projectMemory = page.locator(".project-memory-view");
      assert.equal(await projectMemory.locator("[data-memory-model-enable]").count(), 0);
      await projectMemory.locator('a[href^="/settings/memory-settings"]').click();
      const panel = page.locator('[data-settings-view="memory-settings"]');
      await panel.locator("[data-memory-settings-project]").waitFor({ state: "visible" });
      assert.equal(await panel.locator("[data-memory-settings-project]").inputValue(), project.id);
      const enabled = panel.locator("[data-memory-model-enable]");
      await enabled.waitFor();
      assert(!(await enabled.isChecked()));
      await panel.locator("[data-memory-write]").check();
      await enabled.check();
      const model = panel.locator('[name="project-memory-model"]');
      await panel.locator('[name="project-memory-runtime"]').selectOption("codex");
      await model.selectOption("gpt-fixture");
      await panel.locator("[data-runtime-effort-slider] input[type=range]").press("End");
      await page.screenshot({ path: join(screenshots, "settings-" + locale + ".png") });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await panel.locator("[data-memory-save]").click();
      await waitFor(async () => (await api(path + "/memory-policy")).model.enabled);
      assert.deepEqual((await api(path + "/memory-policy")).model.selection, {
        runtimeId: "codex",
        model: "gpt-fixture",
        effort: "medium",
      });

      const harness = "/api/personal/harness/conversations";
      const { conversation } = await api(harness, "POST", { runtimeId: "codex", projectId: project.id });
      const session = harness + "/" + conversation.id;
      const send = async (text) => {
        await api(session + "/runs", "POST", { text, requestId: crypto.randomUUID() });
        await waitFor(async () => (await api(session)).run?.status === "complete");
      };
      await send("We agreed the cache lasts twenty-four hours.");
      const issued = await api("/api/cli/clients", "POST", {
        name: "Memory integration",
        kind: "cli",
        projectScope: "selected",
        projects: [project.id],
        capabilities: ["memory:read", "memory:organize"],
        expiresInDays: 7,
      });
      const cli = async (command, args) => {
        const response = await fetch(app.base + "/api/cli/v1/execute", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + issued.apiKey,
            "x-panda-client-id": issued.registration.clientId,
            "x-panda-cli-protocol": "1",
          },
          body: JSON.stringify({ schema: 1, command, args: { project: project.id, ...args } }),
        });
        return { status: response.status, value: await response.json() };
      };
      assert.equal((await cli("memory.search", { project: "other-project" })).status, 403);

      const db = new Database(join(app.dir, "panda-state/data/harness.sqlite"));
      try {
        const inUse = () =>
          db
            .query("SELECT json_extract(data, '$.attempts') AS attempt FROM harness_records WHERE id=?")
            .get("memory-organization:" + conversation.id)?.attempt > 0;
        await waitFor(inUse);
        await send("I can still ask a follow-up question.");
        const saved = await api(session);
        assert.equal(saved.messages.filter(({ role }) => role === "user").length, 2);
        await waitFor(
          async () => (await api(path + "/memory")).entries.some(({ key }) => key === "cache-duration"),
          20000,
        );
        const results = await cli("memory.search", {});
        assert.equal(results.status, 200);
        assert.equal(results.value.data.entries[0].value, "twenty-four hours");
        const requestId = crypto.randomUUID(),
          args = { id: conversation.id, days: 7, requestId };
        const organization = await cli("memory.organize", args);
        assert.equal(organization.status, 200);
        assert.equal(organization.value.data.task.from, (await cli("memory.organize", args)).value.data.task.from);
        await waitFor(
          async () => (await cli("memory.status", { id: conversation.id })).value.data.task.state === "complete",
        );

        if (locale === "zh-CN" || locale === "zh-TW") {
          const gate = join(app.dir, "memory-conflict-release");
          const { writeFile, rm } = await import("node:fs/promises");
          await rm(gate, { force: true });
          const from = app.calls().length;
          await send("The confirmed cache duration is seventy-two hours.");
          await waitFor(() =>
            app
              .calls()
              .slice(from)
              .some(
                ({ method, params }) =>
                  method === "turn/start" &&
                  params.input?.[0]?.text?.startsWith('{"key":') &&
                  params.input[0].text.includes('"variants":'),
              ),
          );
          const before = await api(path + "/memory");
          assert.equal(
            before.entries.some(({ key }) => key === "cache-duration"),
            false,
          );
          assert.equal((await api(path + "/memory-terrain")).places.length, 0);
          await page.goto(
            app.base + "/project?id=" + encodeURIComponent(project.id) + "&tab=memory&memoryView=evidence",
          );
          await page.locator(".memory-terrain-state").waitFor();
          assert.equal(await page.locator(".memory-place-conflict, [data-memory-place]").count(), 0);
          await page.screenshot({ path: join(screenshots, "conflict-hidden-" + locale + ".png") });
          await writeFile(gate, "");
          await waitFor(
            async () =>
              (await api(path + "/memory")).entries.some(
                ({ key, value }) => key === "cache-duration" && value === "seventy-two hours",
              ),
            20000,
          );
          const after = await api(path + "/memory");
          const entry = after.entries.find(({ key }) => key === "cache-duration");
          assert.equal(entry.sources.length, 1);
          const detail = await api(path + "/memory/" + entry.id);
          assert(detail.versions.every(({ reason, entry }) => reason !== "conflict" && entry?.state !== "conflict"));
          await page.reload();
          await page.locator("[data-memory-place-detail]").getByText("seventy-two hours", { exact: true }).waitFor();
          await page.screenshot({ path: join(screenshots, "conflict-resolved-" + locale + ".png") });
          const preferences = async (value) => {
            let entry;
            await waitFor(async () => {
              entry = (await api(path + "/memory")).entries.find(({ key }) => key === "food-preferences");
              return entry?.value === value;
            }, 20000);
            return entry;
          };
          await send("I like ramen.");
          await preferences("Likes ramen");
          await send("I also like dumplings.");
          assert.equal((await preferences("Likes ramen and dumplings.")).sources.length, 2);
          await send("I no longer like ramen. Now I prefer noodles.");
          const updated = await preferences("Likes dumplings and noodles.");
          assert.equal(updated.sources.length, 3);
          assert(
            (await api(path + "/memory/" + updated.id)).versions.some(
              ({ entry }) => entry?.value === "Likes ramen and dumplings.",
            ),
          );
          assert(
            app
              .calls()
              .some(
                ({ method, params }) =>
                  method === "turn/start" &&
                  params.input?.[0]?.text?.includes('"summary":true') &&
                  params.input[0].text.includes("food-preferences"),
              ),
          );
        }

        const calls = app.calls();
        assert(
          calls.some(
            ({ method, params }) =>
              method === "thread/start" &&
              params.ephemeral &&
              params.dynamicTools?.some(({ name }) => name === "panda_memory_submit"),
          ),
        );
        const memory = (forLocale) => app.base + "/task/harness:" + forLocale;
        await page.goto(memory(conversation.id));
        await page
          .locator("#sessionInfoButton:visible, #sessionMobileSummary [data-session-action=open]:visible")
          .first()
          .click();
        const inspector = page.locator("#sessionMemoryControl");
        await inspector.locator('[data-session-action="memory-details"]').click();
        const history = page.locator("#sessionMemoryDialog [data-memory-backfill]");
        await history.locator("summary").click();
        await history.locator("select").waitFor();
        assert.deepEqual(
          await history.locator("select option").evaluateAll((items) => items.map(({ value }) => value)),
          ["7", "30"],
        );
        await history.locator("select").selectOption("30");
        await page.screenshot({ path: join(screenshots, "history-" + locale + ".png") });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      } finally {
        db.close();
      }
    } finally {
      await browser.close();
    }
  }
  console.log("Desktop and mobile project memory organization passed in all four locales.");
} finally {
  await app.dispose();
}
