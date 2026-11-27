import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = process.env.PANDA_SESSION_DELETE_PROOF || ".artifacts/session-list-delete";
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
  for (const locale of (process.env.PANDA_SESSION_DELETE_LOCALES || "en,zh-CN,zh-HK,zh-TW").split(","))
    for (const [engine, width] of [
      [chromium, 1440],
      [webkit, 390],
    ]) {
      const browser = await engine.launch(),
        context = await browser.newContext({
          viewport: { width, height: 900 },
          locale,
          isMobile: width < 768,
          hasTouch: width < 768,
          ignoreHTTPSErrors: process.env.PANDA_TEST_HTTPS === "true",
        });
      let page;
      const suffix = locale + "-" + width;
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
        const native = await api("/api/rpc", {
          id: crypto.randomUUID(),
          method: "thread/start",
          params: { cwd: app.alpha },
        });
        assert(native.result?.thread?.id, JSON.stringify(native));
        const nativeId = native.result.thread.id;
        const catalog = await api("/api/projects"),
          projectResponse = await api("/api/projects", {
            code: "delete-" + suffix.toLowerCase(),
            name: "Deletion project",
            revision: catalog.revision,
            operationId: crypto.randomUUID(),
          });
        const project = projectResponse.projects.find((p) => p.code === "delete-" + suffix.toLowerCase());
        await api("/api/projects/assign", {
          projectId: project.id,
          sessionIds: [nativeId],
          revision: projectResponse.revision,
        });
        page = await context.newPage();
        page.setDefaultTimeout(25000);
        await page.routeWebSocket("**/ws", (socket) => socket.close());
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(app.base + "/project?id=" + project.id + "&tab=sessions");
        const text = async (key) =>
          page.evaluate((key) => globalThis[Symbol.for("PandaForce.browserI18n")].t(key), key);
        const option = (id) => page.locator(`[data-wb="session-options"][data-id="${id}"]`);
        const menu = page.locator(".sidebar-project-menu"),
          dialog = page.locator("dialog.confirmation-dialog[open]");
        const openDelete = async (id) => {
          await option(id).click();
          await menu.getByRole("menuitem", { name: await text("sessions.deleteSession"), exact: true }).click();
          await dialog.waitFor();
        };
        await option(nativeId).waitFor();
        await option(nativeId).press("Enter");
        await menu.waitFor();
        assert(
          await menu
            .getByRole("menuitem", { name: await text("projects.openAssignedProject"), exact: true })
            .isVisible(),
        );
        const bounds = await menu.boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        assert(
          await menu
            .getByRole("menuitem")
            .evaluateAll((nodes) => nodes.every((n) => n.getBoundingClientRect().height >= 44)),
        );
        await page.screenshot({ path: join(out, "menu-" + suffix + ".png") });
        await menu.getByRole("menuitem", { name: await text("projects.openAssignedProject"), exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.get("id"), project.id);
        assert.equal(await page.locator("#projectDialog").evaluate((dialog) => dialog.open), false);
        await option(nativeId).press("Enter");
        await page.keyboard.press("Escape");
        assert(await option(nativeId).evaluate((el) => el === document.activeElement));
        await openDelete(nativeId);
        await page.keyboard.press("Escape");
        assert(await option(nativeId).isVisible());
        assert(await option(nativeId).evaluate((el) => el === document.activeElement));
        let failNative = true,
          nativeRequests = 0;
        await page.route("**/api/rpc", async (route) => {
          const body = route.request().postDataJSON();
          if (body.method === "thread/delete" && body.params.threadId === nativeId) {
            nativeRequests++;
            if (failNative) {
              failNative = false;
              return route.fulfill({
                status: 503,
                json: { error: "temporary unavailable", messageId: "errors.couldNotDeleteThread" },
              });
            }
          }
          await route.continue();
        });
        await openDelete(nativeId);
        await dialog.getByRole("button", { name: await text("sessions.deleteSession"), exact: true }).click();
        await page.locator("#persistentErrors .persistent-error").first().waitFor();
        assert(await option(nativeId).isVisible());
        await openDelete(nativeId);
        await dialog.getByRole("button", { name: await text("sessions.deleteSession"), exact: true }).click();
        await option(nativeId).waitFor({ state: "detached" });
        assert.equal(nativeRequests, 2);
        assert((await api("/api/projects")).assignments.every((s) => s.id !== nativeId));
        const managed = await api("/api/personal/harness/conversations", { runtimeId: "grok-local", cwd: app.alpha }),
          id = managed.conversation.id,
          publicId = "harness:" + id;
        const foreignOrigin = await context.request.delete(app.base + "/api/personal/harness/conversations/" + id, {
          headers: { Origin: "https://foreign.invalid" },
        });
        assert(
          [401, 403].includes(foreignOrigin.status()),
          "Foreign-origin deletion must be rejected by authentication or origin validation",
        );
        assert.equal((await context.request.get(app.base + "/api/personal/harness/conversations/" + id)).status(), 200);
        await page.waitForLoadState("networkidle");
        await page.goto(app.base + "/task/" + encodeURIComponent(publicId));
        await page.waitForFunction((id) => globalThis.__pandaForceDebug?.state.active?.id === id, publicId);
        await page.evaluate(() => {
          history.pushState({}, "", "/tasks");
          dispatchEvent(new PopStateEvent("popstate"));
        });
        await option(publicId).waitFor();
        await option(publicId).click();
        assert.equal(
          await menu.getByRole("menuitem", { name: await text("sessions.forkSession"), exact: true }).count(),
          0,
        );
        await menu.getByRole("menuitem", { name: await text("sessions.deleteSession"), exact: true }).click();
        await page.screenshot({ path: join(out, "confirm-" + suffix + ".png") });
        await page.keyboard.press("Escape");
        assert(await option(publicId).isVisible());
        let loseReceipt = true,
          deletes = 0;
        await page.route("**/api/personal/harness/conversations/" + id, async (route) => {
          if (route.request().method() !== "DELETE") return route.continue();
          deletes++;
          if (loseReceipt) {
            loseReceipt = false;
            const r = await route.fetch();
            assert.equal(r.status(), 200);
            return route.abort("failed");
          }
          return route.continue();
        });
        await openDelete(publicId);
        await dialog.getByRole("button", { name: await text("sessions.deleteSession"), exact: true }).click();
        await page.locator("#persistentErrors .persistent-error").first().waitFor();
        assert(await option(publicId).isVisible());
        await openDelete(publicId);
        await dialog.getByRole("button", { name: await text("sessions.deleteSession"), exact: true }).click();
        await option(publicId).waitFor({ state: "detached" });
        assert.equal(deletes, 2);
        assert.equal(new URL(page.url()).pathname, "/tasks");
        const deleted = await context.request.get(app.base + "/api/personal/harness/conversations/" + id);
        assert.equal(deleted.status(), 404);
        const restored = await context.request.post(app.base + "/api/personal/harness/conversations/" + id + "/runs", {
          headers: { Origin: app.base },
          data: { requestId: crypto.randomUUID(), text: "Do not restore" },
        });
        assert.equal(restored.status(), 404);
        await page.waitForLoadState("networkidle");
        await page.reload();
        await page.locator("#wbTaskResults").waitFor();
        assert.equal(await option(publicId).count(), 0);
        assert.equal(await option(nativeId).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(out, "deleted-" + suffix + ".png") });
        records.push({
          locale,
          width,
          sharedMenu: true,
          nativeProjectDeletion: true,
          confirmAndCancelFocus: true,
          failureRetry: true,
          managedLostReceiptRetry: true,
          staysOnList: true,
          noResurrection: true,
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
