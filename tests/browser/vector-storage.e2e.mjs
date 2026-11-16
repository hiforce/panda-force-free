import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const app = await createAppFixture(),
  out = ".artifacts/vector-admin/screens",
  results = [];
await mkdir(out, { recursive: true });
const db = new Database(join(app.dir, "panda-state/data/search.sqlite"), { readonly: true }),
  instance = db.query("SELECT value FROM search_meta WHERE id='instance'").get().value,
  collection = "panda_" + createHash("sha256").update(instance).digest("hex").slice(0, 32) + "_" + "a".repeat(64);
db.close();
let calls = 0,
  release = () => {},
  gate = Promise.resolve();
const peer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-storage-key");
    const path = new URL(request.url).pathname.split("/").at(-1);
    if (path === "list") {
      calls++;
      await gate;
      return Response.json({ code: 0, data: [collection, "other_application_collection"] });
    }
    if (path === "has") return Response.json({ code: 0, data: { has: true } });
    if (path === "describe")
      return Response.json({
        code: 0,
        data: { collectionName: collection, collectionID: "448707763883002001", description: "unowned-resource" },
      });
    throw Error("Unexpected storage operation: " + path);
  },
});
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "zh-CN", "aurora"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
    try {
      await context.addInitScript((theme) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await app.signIn(context);
      const connection = "vectors-" + width;
      const response = await context.request.post(app.base + "/api/search/connections", {
        data: { id: connection, kind: "milvus", url: peer.url.href.slice(0, -1), apiKey: "synthetic-storage-key" },
      });
      assert.equal(response.ok(), true, await response.text());
      gate = new Promise((resolve) => {
        release = resolve;
      });
      const page = await context.newPage(),
        errors = [],
        operations = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(20000);
      await page.goto(app.base + "/settings/search-settings");
      const panel = page.locator("[data-vector-storage]");
      let waitStage = 0;
      const wait = async (check) => {
        const stage = ++waitStage;
        try {
          return await waitFor(check);
        } catch (error) {
          console.error(
            JSON.stringify({
              stage,
              width,
              calls,
              operations,
              errors,
              panel: await panel.innerText().catch(() => "unavailable"),
            }),
          );
          await page.screenshot({ path: `${out}/failure-${width}.png` }).catch(() => {});
          throw error;
        }
      };

      await panel.locator("[data-vector-connection]").selectOption(connection);
      await wait(async () => !(await panel.locator("[data-vector-check]").isDisabled()));
      const before = calls;
      let loseReply = true,
        stallNextReply = false,
        releaseReply = () => {};
      await page.route("**/api/search/vector-storage/check", async (route) => {
        operations.push(route.request().postDataJSON().operationId);
        const response = await route.fetch();
        if (loseReply) {
          loseReply = false;
          await route.abort("failed").catch(() => {});
        } else if (stallNextReply) {
          stallNextReply = false;
          await new Promise((resolve) => {
            releaseReply = resolve;
          });
          await route.abort("failed").catch(() => {});
        } else await route.fulfill({ response });
      });
      await panel.locator("[data-vector-check]").click();
      await wait(async () =>
        /could not be confirmed|无法确认/.test(await panel.locator("[data-vector-notice]").innerText()),
      );
      releaseReply();
      assert.equal(calls, before + 1);
      assert.equal(
        await page.evaluate((id) => sessionStorage.getItem("panda-vector-operation:" + id), connection),
        operations[0],
      );
      await page.reload();
      await wait(async () => /Checking|正在检查/.test(await panel.locator("[data-vector-result]").innerText()));
      assert.equal(await panel.locator("[data-vector-connection]").inputValue(), connection);
      assert.equal(await panel.locator("[data-vector-check]").isDisabled(), true);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/running-${width}.png` });
      const details = panel.locator("[data-vector-details]"),
        summary = details.locator("summary");
      await summary.focus();
      await summary.press("Space");
      release();
      await wait(async () => /Check complete|检查完成/.test(await panel.locator("[data-vector-result]").innerText()));
      assert.equal(await details.evaluate((element) => element.open), true);
      assert.equal(await summary.evaluate((element) => element === document.activeElement), true);
      assert.match(await panel.innerText(), /Checked 1|已检查 1/);
      await panel.locator("[data-vector-check]").click();
      await wait(async () => operations.length === 2);
      assert.equal(operations[0], operations[1]);
      await wait(
        async () =>
          await page.evaluate((id) => sessionStorage.getItem("panda-vector-operation:" + id) === null, connection),
      );
      assert.equal(calls, before + 1);
      const query = page.locator("[data-test-form] [name=pf-search-query]");
      await query.fill("keep my search input");
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${out}/complete-${width}.png` });
      assert.equal(await query.inputValue(), "keep my search input");
      const controlBox = await panel.locator("[data-vector-check]").boundingBox();
      assert.ok(controlBox.height >= (width < 600 ? 44 : 32));
      if (width < 600) {
        const label = await panel.locator("[data-vector-connection]").evaluate((element) => {
          const control = element.getBoundingClientRect(),
            caption = element.closest("label").querySelector("span").getBoundingClientRect();
          return { top: control.top, captionBottom: caption.bottom, width: control.width };
        });
        assert.ok(label.captionBottom <= label.top && label.width > 300);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(
        (await context.request.get(app.base + "/api/search/catalog").then((r) => r.json())).binding.source,
        "builtin",
      );
      assert.deepEqual(errors, []);
      if (width === 1440) {
        // Keep the provider available while only the browser acknowledgement stalls.
        stallNextReply = true;
        await panel.locator("[data-vector-check]").click();
        await wait(async () => /could not be confirmed/.test(await panel.locator("[data-vector-notice]").innerText()));
        releaseReply();
        await panel.locator("[data-vector-check]").click();
        await wait(
          async () =>
            operations.length === 4 &&
            (await page.evaluate((id) => sessionStorage.getItem("panda-vector-operation:" + id) === null, connection)),
        );
        assert.equal(operations[2], operations[3]);
        assert.notEqual(operations[0], operations[2]);
        assert.equal(calls, before + 2);
        let injectFailure = true;
        await page.route("**/api/search/vector-storage?*", async (route) => {
          const response = await route.fetch(),
            value = await response.json();
          if (injectFailure) {
            injectFailure = false;
            await route.fulfill({
              response,
              json: { ...value, state: "failed", failure: "unavailable", nextAt: Date.now() + 1000 },
            });
          } else await route.fulfill({ response });
        });
        await page.reload();
        await wait(async () => /Next retry/.test(await panel.innerText()));
        await wait(async () => /Check complete/.test(await panel.locator("[data-vector-result]").innerText()));
        assert.equal(calls, before + 2);
      }
      assert.equal(
        app.calls().some((call) => call.method === "turn/start"),
        false,
      );
      results.push({
        width,
        locale,
        theme,
        passed: true,
        realAuthenticatedApi: true,
        simulatedStoragePeer: true,
        unknownReplyReused: true,
        refreshResumed: true,
        keyboardFocusAndExpandedDetailsPreserved: true,
        scopeAndSearchInputPreserved: true,
        noModelTask: true,
        stalledReplyBounded: width === 1440,
      });
      await page.close();
    } finally {
      release();
      await context.close();
      await browser.close();
    }
  }
  await writeFile(
    ".artifacts/vector-admin/browser-result.private.json",
    JSON.stringify({ passed: true, records: results }, null, 2) + "\n",
  );
} finally {
  release();
  await peer.stop(true);
  await app.dispose();
}
