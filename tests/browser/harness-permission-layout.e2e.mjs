import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_FORCE_PERMISSION_PROOF || ".artifacts/harness-permission-layout";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  extraEnvironment: ({ dir }) => {
    const account = join(dir, "permission-account");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "auth.json"), '{"fixture":{"access_token":"fixture-only"}}');
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-permission",
          name: "Grok Build",
          command: new URL("../support/grok-acp-fixture.mjs", import.meta.url).pathname,
          accountHome: account,
        },
      ]),
    };
  },
});
const records = [];
try {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 480],
  ])
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      const engine = width === 1440 ? chromium : webkit,
        browser = await engine.launch(),
        context = await browser.newContext({
          viewport: { width, height },
          isMobile: width < 768,
          hasTouch: width < 768,
          colorScheme: locale === "en" ? "light" : "dark",
        });
      try {
        await app.signIn(context);
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
        }, locale);
        const page = await context.newPage(),
          errors = [],
          replies = [];
        let rawTitle;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => {
          if (response.request().method() === "GET" && response.url().includes("/api/personal/harness/conversations/"))
            void response
              .json()
              .then((value) => {
                if (value.permissions?.length) rawTitle = value.permissions[0].title;
              })
              .catch(() => {});
        });
        await page.goto(app.base + "/new");
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="grok-permission"]').click();
        await page.waitForFunction(() =>
          document.querySelector("#composerSettingModel")?.textContent?.includes("Grok Fixture"),
        );
        await page.locator("#toast.show").waitFor({ state: "hidden" });
        await page.locator("#prompt").fill("harness.permission-long");
        await page.locator("#sendButton").click();
        const card = page.locator(".harness-permission"),
          details = card.locator("details"),
          buttons = card.locator("[data-harness-permission]");
        await card.waitFor();
        await waitFor(() => rawTitle);
        await page.locator("#prompt").fill("Keep this unsent draft.");
        if (width < 768) await page.locator("#composer .message-composer-disclosure").click();
        assert.equal(await details.getAttribute("open"), null);
        assert.equal(await details.locator("code").textContent(), rawTitle);
        assert(rawTitle.length > 1000);
        assert.equal(await card.locator("img").count(), 0);
        assert.equal(await page.evaluate(() => !!globalThis.__permissionInjected), false);
        assert.equal(await buttons.count(), 3);
        const geometry = async () => {
          const host = await page.locator("#harnessInteractions").boundingBox();
          const boxes = await buttons.evaluateAll((nodes) =>
            nodes.map((n) => {
              const r = n.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            }),
          );
          for (const box of boxes) {
            assert(box.height >= 44);
            assert(box.x >= 0 && box.x + box.width <= width + 1);
            assert(
              box.y >= Math.max(0, host.y) - 1 && box.y + box.height <= Math.min(height, host.y + host.height) + 1,
              JSON.stringify({ box, host, width, height }),
            );
          }
          for (let i = 1; i < boxes.length; i++)
            assert(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width) >= 7, "Separate action hit areas");
          if (width < 768) for (const box of boxes) assert(box.width < 130);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        };
        await page.screenshot({ path: `${out}/permission-${locale}-${width}.png`, scale: "css" });
        await geometry();
        await details.locator("summary").press("Enter");
        await details.locator("pre").evaluate((n) => {
          n.scrollTop = n.scrollHeight;
        });
        await page.screenshot({ path: `${out}/details-${locale}-${width}.png`, scale: "css" });
        await geometry();
        let release,
          rejectFirst = locale === "en" && width === 390;
        await page.route("**/api/personal/harness/conversations/*/permissions", async (route) => {
          replies.push(route.request().postDataJSON());
          await new Promise((resolve) => {
            release = resolve;
          });
          if (rejectFirst) {
            rejectFirst = false;
            await route.fulfill({ status: 503, json: { code: "unavailable" } });
          } else await route.continue();
        });
        const choice = locale === "zh-CN" ? null : locale === "en" && width === 390 ? "no" : "yes";
        const target = () =>
          choice
            ? card.locator(`[data-harness-option="${choice}"]`)
            : card.locator("[data-harness-permission]:not([data-harness-option])");
        await target().press("Enter");
        await waitFor(() => replies.length === 1 && release);
        assert.equal(await card.getAttribute("aria-busy"), "true");
        assert.equal(await buttons.evaluateAll((nodes) => nodes.every((n) => n.disabled)), true);
        await buttons.evaluateAll((nodes) => {
          for (const n of nodes) n.onclick?.call(n, new MouseEvent("click"));
        });
        assert.equal(replies.length, 1);
        if (locale === "en" && width === 390) {
          const scroll = await details.locator("pre").evaluate((n) => n.scrollTop);
          const settings = await context.newPage();
          await settings.goto(app.base + "/settings/general-settings");
          await settings.locator('[data-settings-page="general-settings"]').click();
          await settings.locator("#languageSelect").selectOption("zh-TW");
          await page.waitForFunction(() => document.documentElement.lang === "zh-TW");
          await page.waitForFunction(() =>
            document.querySelector(".harness-permission-details summary")?.textContent?.includes("操作詳細資訊"),
          );
          assert(await details.evaluate((n) => n.open));
          assert(Math.abs((await details.locator("pre").evaluate((n) => n.scrollTop)) - scroll) < 2);
          assert.equal(await buttons.evaluateAll((nodes) => nodes.every((n) => n.disabled)), true);
          await settings.close();
          release();
          await target().waitFor({ state: "visible" });
          await waitFor(async () => !(await target().isDisabled()));
          assert(await details.evaluate((n) => n.open));
          await target().click();
          await waitFor(() => replies.length === 2);
          release();
        } else release();
        await card.waitFor({ state: "hidden" });
        assert.equal(replies.at(-1).optionId, choice);
        if (replies.length === 2) assert.equal(replies[0].id, replies[1].id);
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this unsent draft.");
        assert.deepEqual(errors, []);
        records.push({
          engine: engine.name(),
          width,
          height,
          locale,
          actionsVisibleInitially: true,
          actionsVisibleExpanded: true,
          compactGaps: true,
          fullEscapedDetails: true,
          keyboard: true,
          duplicateGuard: true,
          choice,
          requests: replies.length,
          draftPreserved: true,
          errors,
        });
      } finally {
        await context.close();
        await browser.close();
      }
    }
  await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log("Harness permission PC/H5 layout, bounded details, exact choices and failure/locale recovery passed.");
} finally {
  await app.dispose();
}
