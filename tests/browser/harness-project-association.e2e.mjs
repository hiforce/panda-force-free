import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
const out = process.env.PANDA_HARNESS_PROJECT_PROOF || ".artifacts/harness-project-association";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  extraEnvironment: ({ dir }) => {
    const account = join(dir, "grok-account");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "auth.json"), JSON.stringify({ fixture: { access_token: "fixture-only" } }));
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-local",
          name: "Grok Local",
          command: resolve("tests/support/grok-acp-fixture.mjs"),
          accountHome: account,
        },
      ]),
    };
  },
});
const records = [];
try {
  for (const locale of (process.env.PANDA_HARNESS_PROJECT_LOCALES || "en,zh-CN,zh-HK,zh-TW").split(","))
    for (const [engine, width] of [
      [chromium, 1440],
      [webkit, 390],
    ]) {
      const browser = await engine.launch(),
        context = await browser.newContext({
          viewport: { width, height: 900 },
          isMobile: width < 768,
          hasTouch: width < 768,
          ignoreHTTPSErrors: process.env.PANDA_TEST_HTTPS === "true",
        });
      let page;
      const suffix = locale.toLowerCase() + "-" + width;
      try {
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
        }, locale);
        await app.signIn(context);
        const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
          const r = await context.request.fetch(app.base + path, {
            method,
            headers: { Origin: app.base },
            ...(body === undefined ? {} : { data: body }),
          });
          assert(r.ok(), path + " " + r.status() + " " + (await r.text()));
          return r.json();
        };
        let cat = await api("/api/projects");
        cat = await api("/api/projects", {
          name: "Project A " + suffix,
          code: "project-a-" + suffix,
          revision: cat.revision,
          operationId: crypto.randomUUID(),
        });
        const a = cat.projects.find((p) => p.code === "project-a-" + suffix);
        cat = await api("/api/projects", {
          name: "Project B " + suffix,
          code: "project-b-" + suffix,
          revision: cat.revision,
          operationId: crypto.randomUUID(),
        });
        const b = cat.projects.find((p) => p.code === "project-b-" + suffix);
        page = await context.newPage();
        page.setDefaultTimeout(25000);
        const navigate = async (url) => {
          // Let owned snapshot reads settle before deliberately replacing the fixture document.
          await page.waitForLoadState("networkidle");
          await page.goto(url);
        };
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await navigate(app.base + "/project?id=" + a.id + "&tab=sessions");
        await page.locator('[data-wb="project-new"]').first().click();
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        assert.equal(await page.locator("#sessionProjectSelect").inputValue(), a.id);
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="grok-local"]').click();
        await page.locator("#harnessMenu").waitFor({ state: "hidden" });
        await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
        await page.locator("#prompt").fill("A project conversation " + suffix);
        const created = page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/personal/harness/conversations" && r.request().method() === "POST",
        );
        await page.locator("#composer").evaluate((form) => form.requestSubmit());
        const response = await created;
        assert.equal(response.status(), 201, await response.text());
        const managed = await response.json(),
          id = "harness:" + managed.conversation.id;
        assert.equal(managed.conversation.projectId, a.id);
        await waitFor(async () =>
          (await api("/api/projects")).assignments.some((s) => s.id === id && s.projectId === a.id),
        );
        await page.waitForFunction((id) => globalThis.__pandaForceDebug?.state.active?.id === id, id);
        assert.match(await page.locator("#businessProjectContext").innerText(), new RegExp(a.name));
        await waitFor(
          async () =>
            !(await api("/api/personal/harness/conversations/" + managed.conversation.id)).conversation.activeRunId,
        );
        const before = await api("/api/personal/harness/conversations/" + managed.conversation.id),
          dialog = page.locator("#projectDialog"),
          submit = dialog.locator('[type="submit"]');
        const open = async () => {
          await page.locator("#sessionInfoButton").click();
          await page.locator("#sessionAssociateProject").click();
          await dialog.waitFor({ state: "visible" });
          await page.locator("#associationProject").selectOption(b.id);
        };
        await open();
        let first = true,
          release;
        let saves = 0;
        await page.route("**/api/projects/assign", async (route) => {
          saves++;
          if (first) {
            first = false;
            await new Promise((resolve) => {
              release = resolve;
            });
            return route.fulfill({
              status: 503,
              json: { messageId: "errors.couldNotUpdateProject", error: "Unavailable fixture" },
            });
          }
          await route.continue();
        });
        await submit.click();
        await page.waitForFunction(
          () => document.querySelector("#projectAssociationForm").getAttribute("aria-busy") === "true",
        );
        assert(await submit.isDisabled());
        await dialog.locator("form").evaluate((form) => form.requestSubmit());
        assert.equal(saves, 1);
        release();
        await dialog.locator(".project-error:visible").waitFor();
        assert.equal(await page.locator("#associationProject").inputValue(), b.id);
        assert(await dialog.locator(".project-error").evaluate((el) => el === document.activeElement));
        await page.screenshot({ path: join(out, "retry-" + suffix + ".png") });
        await submit.click();
        await dialog.waitFor({ state: "hidden" });
        assert.equal(saves, 2);
        await waitFor(async () =>
          (await api("/api/projects")).assignments.some((s) => s.id === id && s.projectId === b.id),
        );
        await page.waitForLoadState("networkidle");
        await page.reload();
        await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
        await page.waitForFunction(
          (name) => document.querySelector("#sessionHeadingProject")?.textContent === name,
          b.name,
        );
        const after = await api("/api/personal/harness/conversations/" + managed.conversation.id);
        assert.equal(after.conversation.cwd, before.conversation.cwd);
        assert.deepEqual(after.messages, before.messages);
        await navigate(app.base + "/project?id=" + b.id + "&tab=sessions");
        await page.locator(`[data-wb="session-options"][data-id="${id}"]`).click();
        const change = await page.evaluate(() =>
          globalThis[Symbol.for("PandaForce.browserI18n")].t("common.changeProject"),
        );
        await page.locator(".sidebar-project-menu").getByRole("menuitem", { name: change, exact: true }).click();
        await dialog.waitFor({ state: "visible" });
        await page.locator("#associationProject").selectOption("");
        await submit.click();
        await dialog.waitFor({ state: "hidden" });
        assert(!(await api("/api/projects")).assignments.some((s) => s.id === id));
        await navigate(app.base + "/project?id=" + a.id + "&tab=sessions");
        await page.locator('[data-wb="project-link"]').click();
        await dialog.locator(`input[value="${id}"]`).check();
        await submit.click();
        await dialog.waitFor({ state: "hidden" });
        assert((await api("/api/projects")).assignments.some((s) => s.id === id && s.projectId === a.id));
        if (locale === "en") {
          const n = await api("/api/rpc", {
              id: crypto.randomUUID(),
              method: "thread/start",
              params: { cwd: app.alpha },
            }),
            nativeId = n.result.thread.id;
          cat = await api("/api/projects");
          await api("/api/projects/assign", { projectId: b.id, sessionIds: [nativeId], revision: cat.revision });
          await navigate(app.base + "/task/" + nativeId);
          await page.waitForFunction((id) => globalThis.__pandaForceDebug?.state.active?.id === id, nativeId);
          await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
          await page.locator("#prompt").fill("Keep imported draft");
          await page.locator("#harnessButton").click();
          await page.locator('[data-harness-select="grok-local"]').click();
          await page.locator("#harnessMenu").waitFor({ state: "hidden" });
          await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.active?.id?.startsWith("harness:"));
          const imported = await page.evaluate(() => globalThis.__pandaForceDebug.state.active.id);
          await waitFor(async () =>
            (await api("/api/projects")).assignments.some((s) => s.id === imported && s.projectId === b.id),
          );
          assert.equal(await page.locator("#prompt").inputValue(), "Keep imported draft");
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: join(out, "associated-" + suffix + ".png") });
        records.push({
          locale,
          width,
          autoAssignment: true,
          manualMove: true,
          unlink: true,
          managedPicker: true,
          failedSaveRetry: true,
          duplicateSubmitCoalesced: true,
          historyAndCwdPreserved: true,
          nativeImportAssociation: locale === "en",
        });
      } catch (error) {
        if (page) {
          await page.screenshot({ path: join(out, "failure-" + suffix + ".png") });
          await writeFile(
            join(out, "failure-" + suffix + ".txt"),
            String(error) + "\n" + (await page.locator("body").innerText()),
          );
        }
        throw error;
      } finally {
        await context.close();
        await browser.close();
      }
    }
  await writeFile(join(out, "result.json"), JSON.stringify({ passed: true, records }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: records.length }));
} finally {
  await app.dispose();
}
