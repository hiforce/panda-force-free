import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { objectStorageFixture } from "../support/object-storage-fixture.ts";

const store = await objectStorageFixture();
assert(store, "Set PANDA_FORCE_TEST_MINIO_IMAGE to run the isolated storage browser test.");
const app = await createAppFixture({ startupTimeoutMs: 60000 });
const bucket = "browsing-fixture";
const id = crypto.randomUUID();
const output = process.env.PANDA_STORAGE_BROWSER_PROOF ?? ".artifacts/storage-browser";
const file = "原件 + final.pdf";
const payload = "A private fixture";
try {
  await mkdir(output, { recursive: true });
  assert.equal((await store.request("PUT", "/" + bucket)).status, 200);
  const files = [
    ["studio/旅行简报/" + file, payload],
    ["studio/旅行简报/参考资料/场景.png", "nested"],
    ["studio/视频素材/采访.mp4", "video"],
    ["studio/未使用/", ""],
    ["studio/交付说明.txt", "notes"],
    ["outside/private.txt", "must not appear"],
  ];
  for (const [key, content] of files) {
    const url = "/" + bucket + "/" + key.split("/").map(encodeURIComponent).join("/");
    assert.equal((await store.request("PUT", url, new TextEncoder().encode(content))).status, 200);
  }
  for (let page = 0; page < 5; page++) {
    await Promise.all(
      Array.from({ length: 17 }, async (_, index) => {
        const key = "report-" + String(page * 17 + index).padStart(3, "0") + ".txt";
        assert.equal((await store.request("PUT", "/" + bucket + "/studio/旅行简报/批量归档/" + key)).status, 200);
      }),
    );
  }

  for (const [engine, width, locale] of [
    [chromium, 1440, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const mobile = width < 768;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 850 },
        isMobile: mobile,
        hasTouch: mobile,
        acceptDownloads: true,
        colorScheme: "dark",
      });
      await app.signIn(context);
      await context.addInitScript((locale) => {
        if (window !== window.top || !["http:", "https:"].includes(location.protocol)) return;
        try {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "dark");
        } catch {}
      }, locale);
      const registry = app.base + "/api/system/storage-connections";
      if (!mobile) {
        const response = await context.request.post(registry, {
          headers: { Origin: app.base },
          data: {
            id,
            name: "Studio Archive",
            provider: "s3",
            region: "us-east-1",
            prefix: "studio",
            bucket,
            endpoint: store.endpoint,
            forcePathStyle: true,
            ...store.credentials,
          },
        });
        assert.equal(response.status(), 200, await response.text());
        const unauthorized = await browser.newContext();
        assert([401, 403].includes((await unauthorized.request.get(registry + "/browse?connection=" + id)).status()));
        await unauthorized.close();
        assert.equal(
          (await context.request.get(registry + "/browse?connection=" + id + "&folder=outside%2F")).status(),
          400,
        );
        assert.equal(
          (
            await context.request.get(registry + "/browse/download?connection=" + id + "&file=outside%2Fprivate.txt")
          ).status(),
          400,
        );
      }
      const parent = await context.newPage();
      await parent.goto(app.base + "/tools/storage");
      const showSidebar = async () => {
        const executor = parent.locator(".workspace-tool-executors");
        if (!(await executor.isVisible())) {
          await parent.locator("#workspaceNavigationToggle:visible, #toggleSidebar:visible").first().click();
        }
        await executor.waitFor();
        const labels = await executor
          .locator("..")
          .evaluate((element) =>
            [...element.querySelectorAll(".workspace-tool-executors, [data-workspace-tool]")].map(
              (button) => button.dataset.workspaceTool || "executors",
            ),
          );
        assert.deepEqual(labels.slice(0, 3), ["executors", "remote", "storage"]);
        await executor.click();
        await parent.locator('[data-settings-content="media-executors"]:visible').waitFor();
        assert.equal(new URL(parent.url()).pathname, "/settings/media-executors");
        await parent.goto(app.base + "/tools/storage");
      };
      const prep = parent.locator("#workspacePreparationContinue");
      const browse = parent.locator('a.storage-tool-browse[target="_blank"]');
      await browse.waitFor({ state: "attached" });
      try {
        if (await prep.isVisible()) await prep.click({ timeout: 2000 });
      } catch (error) {
        if (await prep.isVisible()) throw error;
      }
      await showSidebar();
      assert(parent.url().endsWith("/tools/storage"));
      const [page] = await Promise.all([context.waitForEvent("page"), browse.click()]);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const row = (name) => page.locator("tbody tr").filter({ hasText: name });
      await page.getByRole("heading", { name: "Studio Archive" }).waitFor();
      await row("旅行简报").waitFor();
      assert.equal(await row("private.txt").count(), 0);
      const folder = row("旅行简报").getByRole("link");
      if (mobile) await folder.tap();
      else {
        await folder.focus();
        await page.keyboard.press("Enter");
      }
      await row(file).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const input = page.locator("[data-browser-filter]");
      await input.fill("not-in-this-folder");
      await page.locator("[data-browser-state]:visible").waitFor();
      await input.fill("");
      await row(file).waitFor();
      const [download] = await Promise.all([page.waitForEvent("download"), row(file).locator("[download]").click()]);
      const suggested = download.suggestedFilename();
      assert(suggested === file || (mobile && suggested === file.replaceAll(" ", "_")));
      assert.equal(await readFile(await download.path(), "utf8"), payload);
      await page.screenshot({ path: join(output, `browser-${locale}-${width}.png`), animations: "disabled" });
      const nested = row("参考资料").getByRole("link");
      await nested.click();
      await row("场景.png").waitFor();
      await page.locator("[data-browser-up]").click();
      await row(file).waitFor();
      await row("批量归档").getByRole("link").click();
      await row("report-000.txt").waitFor();
      assert.equal(await row("report-084.txt").count(), 0);
      const more = page.locator("[data-browser-more]");
      await more.click();
      await row("report-084.txt").waitFor();
      assert.equal(await row("report-000.txt").count(), 1);
      await more.waitFor({ state: "hidden" });
      await page.goBack();
      await row(file).waitFor();
      await page.route("**/api/system/storage-connections/browse?*", (route) => route.abort(), { times: 1 });
      await page.locator("[data-browser-refresh]").click();
      await page.locator("[data-browser-retry]").click();
      await page.locator("[data-browser-retry]").waitFor({ state: "hidden" });
      await row(file).waitFor();
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `${locale} ${width}: standalone tab, access scope, nested navigation, filtering, download, pagination and retry verified`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await Promise.all([app.dispose(), store.close()]);
}
