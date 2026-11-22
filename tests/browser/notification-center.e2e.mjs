import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { NOTIFICATION_PAGE_SIZE, NOTIFICATION_PREVIEW_SIZE } from "../../src/shared/notifications/contracts.js";
import { NotificationCenter } from "../../src/server/notifications/center.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_NOTIFICATION_CENTER_PROOF || ".artifacts/notification-center";
await mkdir(out, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 60000 });
const records = [];
try {
  for (const [engine, width, appearance] of [
    [chromium, 1440, "light"],
    [webkit, 390, "aurora"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((theme) => {
        if (window === window.top) localStorage.setItem("panda-force-theme", theme);
      }, appearance);
      const titles = [
        "市场研究季度报告",
        "Product launch storyboard",
        "品牌风格参考与桌面图标",
        "Onboarding walkthrough",
        "Editorial calendar",
      ];
      const entries = Array.from({ length: 35 }, (_, index) => {
        const taskId = `c2445740-a556-4b58-b3e1-${String(index).padStart(12, "0")}`;
        const title = `${titles[index % titles.length]} · ${String(index + 1).padStart(2, "0")}`;
        const kind = ["document", "slides", "image", "video", "web"][index % 5];
        const source = index === 17 ? "build-system" : index % 2 ? "creation" : "personal-creation";
        const artifact =
          kind === "document"
            ? { kind, title, projectId: "project-1", documentId: taskId, operationId: taskId, treeVersion: 1 }
            : { kind, title, projectId: "project-1", assetId: taskId, operationId: taskId, version: "version-1" };
        return {
          source,
          id: taskId,
          readAt: index < 6 ? null : 1000,
          createdAt: Date.UTC(2026, 10, 21, 12, 0) - index * 120000,
          title,
          category: source === "build-system" ? "notice" : kind,
          ...(source === "build-system"
            ? {
                description: "Package is ready.\n<em>See the linked build log.</em>",
                action: { type: "link", href: "https://example.test/build/18", label: "Open build log" },
              }
            : { action: { type: "intent", name: "creation.deliverable", data: artifact } }),
        };
      });
      const feed = new NotificationCenter(
        ["creation", "personal-creation", "build-system"].map((id) => {
          const items = entries.filter((entry) => entry.source === id);
          return {
            id,
            async preview() {
              const unreadCount = items.filter((item) => item.readAt === null).length;
              return { items: items.slice(0, NOTIFICATION_PREVIEW_SIZE), unreadCount };
            },
            async history(_owner, before) {
              const start = before ? items.findIndex((item) => item.id === before) + 1 : 0;
              const page = items.slice(start, start + NOTIFICATION_PAGE_SIZE);
              return { items: page, more: start + page.length < items.length };
            },
            async read(_owner, id) {
              const entry = items.find((item) => item.id === id);
              if (entry) entry.readAt ??= Date.now();
              return Boolean(entry);
            },
          };
        }),
      );
      let failNext = false;
      let slowRetry = false;
      await context.route("**/api/notifications?*", async (route) => {
        const { searchParams } = new URL(route.request().url());
        if (searchParams.get("view") === "preview") return route.fulfill({ json: await feed.preview("owner") });
        assert.equal(searchParams.get("view"), "history");
        const cursor = searchParams.get("cursor");
        if (cursor && failNext) {
          failNext = false;
          return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        }
        if (cursor && slowRetry) await Bun.sleep(650);
        return route.fulfill({ json: await feed.history("owner", cursor) });
      });
      await context.route("**/api/notifications/read", async (route) => {
        const { source, id } = route.request().postDataJSON();
        await route.fulfill({ json: { read: await feed.read("owner", source, id) } });
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/tasks");
      await page.waitForFunction((theme) => document.documentElement.dataset.appearance === theme, appearance);
      const bell = page.locator("#notificationCenterButton");
      const dialog = page.locator("#notificationCenterDialog");
      const rows = dialog.locator(".notification-row");
      const titlesOnPage = () => rows.locator("strong").allTextContents();
      for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
        const copy = JSON.parse(await readFile(`src/shared/i18n/locales/${locale}/notifications.json`, "utf8"));
        await page.evaluate((lang) => globalThis.__pandaForceI18n.setPreference(lang), locale);
        await bell.click();
        await waitFor(async () => (await rows.count()) === 5);
        await dialog.getByText(copy.viewAll, { exact: true }).waitFor();
        const box = await dialog.boundingBox();
        assert(box.width < 430 && box.height < 410);
        assert(box.y >= (await bell.boundingBox()).y);
        assert((await rows.first().boundingBox()).height >= 44);
        assert(await dialog.locator("[data-notifications-back]").isHidden());
        assert(await dialog.locator("h2").evaluate((heading) => getComputedStyle(heading).outlineStyle === "none"));
        await page.screenshot({ path: `${out}/preview-${locale}-${width}.png`, scale: "css" });
        await dialog.locator("[data-notifications-all]").press("Enter");
        await waitFor(async () => (await rows.count()) === 12);
        assert.deepEqual(
          await titlesOnPage(),
          entries.slice(0, 12).map(({ title }) => title),
        );
        await page.screenshot({ path: `${out}/history-${locale}-${width}.png`, scale: "css" });
        const next = dialog.locator("[data-notifications-next]");
        if (locale === "en") {
          failNext = true;
          await next.click();
          await dialog.getByText(copy.loadFailed).waitFor();
          assert.deepEqual(
            await titlesOnPage(),
            entries.slice(0, 12).map(({ title }) => title),
          );
          slowRetry = true;
          await dialog.locator(".notification-center-retry").click();
          await dialog.locator(".notification-center-busy:visible").waitFor();
        } else await next.click();
        await waitFor(async () => (await titlesOnPage())[0] === entries[12].title, 20000);
        slowRetry = false;
        assert.deepEqual(
          await titlesOnPage(),
          entries.slice(12, 24).map(({ title }) => title),
        );
        const target = rows.nth(4);
        const key = await target.getAttribute("data-notification-key");
        await target.press("Enter");
        await dialog.getByText(copy.details, { exact: true }).waitFor();
        await dialog.getByRole("heading", { name: entries[16].title, exact: true }).waitFor();
        await dialog.locator("[data-notifications-deliver]:visible").waitFor();
        await page.screenshot({ path: `${out}/detail-${locale}-${width}.png`, scale: "css" });
        await dialog.locator("[data-notifications-back]").click();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-notification-key")), key);
        await rows.nth(5).press("Enter");
        const link = dialog.locator("[data-notifications-link]");
        await link.waitFor();
        assert.equal(await link.getAttribute("href"), "https://example.test/build/18");
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.match(await link.getAttribute("rel"), /noopener/);
        assert.equal(await link.textContent(), "Open build log");
        assert.equal(await dialog.locator(".notification-description").textContent(), entries[17].description);
        assert.equal(await dialog.locator(".notification-description em").count(), 0);
        await page.screenshot({ path: `${out}/link-${locale}-${width}.png`, scale: "css" });
        await dialog.locator("[data-notifications-back]").click();
        await next.click();
        await waitFor(async () => (await titlesOnPage())[0] === entries[24].title);
        assert.deepEqual(
          await titlesOnPage(),
          entries.slice(24).map(({ title }) => title),
        );
        assert(await next.isDisabled());
        await dialog.locator("[data-notifications-previous]").click();
        assert.deepEqual(
          await titlesOnPage(),
          entries.slice(12, 24).map(({ title }) => title),
        );
        await page.keyboard.press("Escape");
        await waitFor(() => bell.evaluate((element) => document.activeElement === element));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        records.push({
          locale,
          width,
          compact: true,
          pagination: true,
          details: true,
          focusRestored: true,
          hyperlink: true,
          appearance,
        });
      }
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await app.dispose();
}
await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
