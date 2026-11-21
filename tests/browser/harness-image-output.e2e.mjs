import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const out = process.env.PANDA_FORCE_MEDIA_PROOF || ".artifacts/harness-image-output";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  extraEnvironment: ({ dir }) => {
    const account = join(dir, "image-account");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "auth.json"), '{"fixture":{"access_token":"fixture-only"}}');
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-image",
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
  for (const width of [1440, 390])
    for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
      const browser = await (width === 1440 ? chromium : webkit).launch();
      const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 900 : 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      try {
        await app.signIn(context);
        await context.addInitScript((locale) => {
          if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-locale", locale);
        }, locale);
        const page = await context.newPage(),
          errors = [];
        page.setDefaultTimeout(20000);
        page.setDefaultNavigationTimeout(60000);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(app.base + "/new");
        await page.locator("#harnessButton").click();
        await page.locator('[data-harness-select="grok-image"]').click();
        await page.waitForFunction(() =>
          document.querySelector("#composerSettingModel")?.textContent?.includes("Grok Fixture"),
        );
        await page.locator("#toast.show").waitFor({ state: "hidden" });
        await page.locator("#prompt").fill("harness.output-image");
        await page.locator("#sendButton").click();
        const image = page.locator("#conversation button.message-image-button img").last();
        await image.waitFor();
        await page.waitForFunction(() =>
          [...document.querySelectorAll("#conversation .message-image")].some((n) => n.naturalWidth > 0),
        );
        const src = await image.getAttribute("src"),
          path = new URL(src, app.base).searchParams.get("path");
        assert.equal(new URL(src, app.base).pathname, "/api/images/local");
        assert.equal(new URL(src, app.base).searchParams.get("thumbnail"), "1");
        assert(path.endsWith("/中国 历史漫画.png"));
        await page.waitForFunction(() => location.pathname !== "/new");
        await page.reload();
        await image.waitFor();
        await page.waitForFunction(() =>
          [...document.querySelectorAll("#conversation .message-image")].some((n) => n.naturalWidth > 0),
        );
        await image.locator("..").press("Enter");
        await page.locator("#imageViewer[open]").waitFor();
        await page.waitForFunction(() => document.querySelector("#imageViewerImage").naturalWidth > 0);
        assert.equal(await page.locator("#imageViewerTitle").textContent(), "中国 历史漫画.png");
        const href = await page.locator("#imageViewerDownload").getAttribute("href"),
          direct = await context.request.get(app.base + href);
        assert.equal(direct.status(), 200);
        assert.equal(direct.headers()["content-type"], "image/png");
        assert(direct.headers()["content-disposition"].startsWith("attachment;"));
        assert(direct.headers()["content-disposition"].includes(encodeURIComponent("中国 历史漫画.png")));
        const original = readFileSync(path);
        assert(Buffer.from(await direct.body()).equals(original));
        const downloaded = page.waitForEvent("download");
        await page.locator("#imageViewerDownload").click();
        const download = await downloaded;
        assert.equal(download.suggestedFilename().replaceAll("_", " "), "中国 历史漫画.png");
        assert(readFileSync(await download.path()).equals(original));
        await page.screenshot({ path: `${out}/image-${locale}-${width}.png`, scale: "css" });
        await page.locator("#closeImageViewer").click();
        assert.equal(await image.locator("..").evaluate((n) => document.activeElement === n), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        const unauthorized = await fetch(app.base + href);
        assert.equal(unauthorized.status, 401);
        const denied = await context.request.get(
          app.base + "/api/images/local?path=" + encodeURIComponent("/etc/passwd"),
        );
        assert.equal(denied.status(), 404);
        assert.deepEqual(errors, []);
        records.push({
          width,
          locale,
          historyReload: true,
          thumbnail: true,
          preview: true,
          downloadBytes: true,
          auth: true,
          errors,
        });
      } finally {
        await context.close();
        await browser.close();
      }
    }
  await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log("Harness output images preview and download after history reload on PC/H5 in all four languages.");
} finally {
  await app.dispose();
}
