import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fixture = await createAppFixture();
const out = process.env.PANDA_FORCE_PROJECT_DIRECTORY_EVIDENCE || ".artifacts/project-directory";
await mkdir(out, { recursive: true });
const records = [],
  errors = [];
const examples = [
  ["Rocky's Blog", "rocky-blog", "Notes on products, engineering and the work in between."],
  ["PandaForce", "panda-force", "A thoughtful workspace for documents, knowledge and AI."],
  ["PixelForce", "pixel-force", "From visual ideas to polished digital experiences."],
  ["SparkForce", "spark-force", ""],
  ["文档功能体验", "document-preview", "产品说明、写作实践与发布流程。"],
  ["Developer handbook", "developer-handbook", "Practical guides for the people building our products."],
  ["Product launch", "product-launch", "A shared plan for our next release."],
  ["Research notebook", "research-notebook", "Questions, evidence and the discoveries worth keeping."],
  ["Architecture decisions", "architecture-decisions", "Clear context for important engineering choices."],
  ["Customer stories", "customer-stories", "Useful conversations and lessons from our customers."],
  ["Brand studio", "brand-studio", "Voice, visuals and a consistent product identity."],
  ["Team learning", "team-learning", "Make space to learn, share and improve."],
  [
    "A long project title for international product documentation and release planning",
    "long-project-title",
    "A long description ".repeat(15),
  ],
  ["Literal <img src=x onerror=alert(1)> title", "escaped-project", "HTML stays ordinary project content."],
  ...Array.from({ length: 23 }, (_, n) => [
    "Archive " + String(n + 1).padStart(2, "0"),
    "archive-" + n,
    "Completed explorations and useful reference material.",
  ]),
];
examples.push(...examples.splice(12, 2));
let catalog = { revision: 0 };
const ids = [];
for (const [name, code, description] of examples) {
  catalog = fixture.legacyProject({ name, code, description, revision: catalog.revision });
  ids.push(catalog.projects.find((project) => project.code === code).id);
}
const db = new Database(join(fixture.dir, "panda-state/data/projects.sqlite"));
examples.forEach((_, index) =>
  db.query("UPDATE projects SET updated_at=? WHERE id=?").run(Date.now() - index * 86400000, ids[index]),
);
db.close();
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-TW"],
  ]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("panda-force-theme", "aurora");
      } catch {}
    });
    try {
      await fixture.signIn(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error(error.message);
      });
      await page.goto(fixture.base + "/projects");
      const items = page.locator(".project-directory-item");
      await items.nth(23).waitFor();
      assert.equal(await items.count(), 24);
      assert.equal(await page.locator(".project-directory-collection").getAttribute("data-layout"), "list");
      assert.equal(await page.locator("#project-filter-all > span:last-child").innerText(), "37");
      const first = page.locator(`[data-project-item="${ids[0]}"]`);
      await first.locator('[data-wb="pin"]').click();
      await waitFor(async () => (await first.locator('[data-wb="pin"]').getAttribute("aria-pressed")) === "true");
      await page.locator("#project-filter-pinned").click();
      assert.equal(await items.count(), 1);
      await page.locator("#project-layout-cards").click();
      assert.equal(await items.count(), 1);
      await page.locator("#project-filter-all").click();
      await page.locator("#projectDirectorySort").selectOption("name");
      await page.locator("#wbProjectSearch").fill("pixel digital");
      assert.equal(await items.count(), 1);
      assert.ok((await items.innerText()).includes("PixelForce"));
      await page.locator(".project-directory-main").click();
      await page.waitForURL((url) => url.pathname === "/project" && url.searchParams.get("id") === ids[2]);
      await page.goBack();
      await page.locator("#wbProjectSearch").waitFor();
      assert.equal(await page.locator("#wbProjectSearch").inputValue(), "pixel digital");
      assert.equal(await page.locator(".project-directory-collection").getAttribute("data-layout"), "cards");
      await page.locator("#wbProjectSearch").fill("no project has this name");
      await page.locator('[data-project-action="reset"]').click();
      assert.equal(await items.count(), 24);
      await page.locator('[data-project-action="next"]:visible').first().click();
      assert.equal(await items.count(), 13);
      await page.locator("#project-layout-list").click();
      assert.equal(await items.count(), 13);
      await page.locator('[data-project-action="previous"]:visible').first().click();
      await page.locator("#projectDirectorySort").selectOption("updated");
      await page.locator("#wbProjectSearch").fill("escaped-project");
      assert.equal(await page.locator(".project-directory-item img").count(), 0);
      assert.ok((await items.innerText()).includes("<img"));
      await page.locator("#wbProjectSearch").fill("");
      for (const language of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
        await page.evaluate((value) => globalThis.__pandaForceI18n.setPreference(value), language);
        for (const mode of ["list", "cards"]) {
          await page.locator("#project-layout-" + mode).click();
          for (const id of [ids[1], ids[3]]) {
            const code = page.locator(`[data-project-item="${id}"] code`);
            assert.ok(
              await code.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
              "Short project codes must fit with or without a description",
            );
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          assert.equal(await page.locator("#projectDirectorySort").inputValue(), "updated");
          const search = await page.locator("#wbProjectSearch").boundingBox();
          const create = await page.locator('.project-directory-heading [data-wb="create-project"]').boundingBox();
          const title = await page.locator(".project-directory-heading h1").boundingBox();
          const center = (box) => box.y + box.height / 2;
          assert.ok(Math.abs(center(search) - center(create)) < 3 && Math.abs(center(search) - center(title)) < 3);
          if (width === 1440) {
            const sort = await page.locator("#projectDirectorySort").boundingBox();
            const toggle = await page.locator(".project-directory-layout").boundingBox();
            assert.ok(
              Math.abs(center(search) - center(sort)) < 3 && Math.abs(center(search) - center(toggle)) < 3,
              "Desktop toolbar must occupy one row",
            );
          }
          const iconBounds = await page.locator(".project-directory-search-control > .icon-slot").boundingBox();
          const inputBounds = await page.locator("#wbProjectSearch").boundingBox();
          const padding = await page
            .locator("#wbProjectSearch")
            .evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft));
          assert.ok(iconBounds.x >= inputBounds.x && iconBounds.x + iconBounds.width <= inputBounds.x + padding);
          const geometry = await items.evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = node.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width };
            }),
          );
          if (width === 1440 && mode === "list") assert.ok(geometry[0].height <= 88);
          if (width === 1440 && mode === "cards")
            assert.ok(geometry.filter((rect) => rect.top === geometry[0].top).length >= 3);
          if (width === 390) {
            for (const control of await page
              .locator(".project-directory-item:first-child .project-directory-actions .wb-button")
              .all()) {
              const bounds = await control.boundingBox();
              assert.ok(bounds.height >= 44 && bounds.width >= 44);
            }
          }
          await page.screenshot({ path: `${out}/${width}-${language}-${mode}.png` });
          records.push({
            width,
            language,
            mode,
            rowHeight: geometry[0].height,
            firstScreen: geometry.filter((rect) => rect.top >= 0 && rect.bottom <= 960).length,
            noHorizontalOverflow: true,
          });
        }
      }
      await page.locator("#project-layout-cards").focus();
      await page.keyboard.press("Enter");
      await page.reload();
      await items.nth(23).waitFor();
      assert.equal(await page.locator(".project-directory-collection").getAttribute("data-layout"), "cards");
      assert.equal(await page.locator("#projectDirectorySort").inputValue(), "updated");
      if (width === 1440) {
        for (const narrow of [320, 768, 1769]) {
          await page.setViewportSize({ width: narrow, height: 960 });
          for (const mode of ["list", "cards"]) {
            await page.locator("#project-layout-" + mode).click();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          }
        }
        await page.setViewportSize({ width, height: 960 });
      }
      if (width === 1440) {
        await page.locator("#wbProjectSearch").fill("rocky-blog");
        await page.locator(".project-directory-actions a").click();
        await page.waitForURL((url) => url.pathname === "/documents" && url.searchParams.get("project") === ids[0]);
        await page.goBack();
        await page.locator('[data-wb="project-new"]').click();
        await page.waitForURL((url) => url.pathname === "/new" && url.searchParams.get("project") === ids[0]);
      }
      if (width === 390) {
        await page.goto(fixture.base + "/projects");
        await page.locator('[data-wb="create-project"]').first().click();
        await page.locator("#projectNameInput").fill("Directory creation check");
        await page.locator("#projectCodeInput").fill("directory-check");
        await page.locator('#projectForm [type="submit"]').click();
        await page.locator("#projectDialog").waitFor({ state: "hidden" });
        await page.waitForURL((url) => url.pathname === "/project");
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/results.json",
    JSON.stringify({ passed: true, records, errors, scope: "project directory only" }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, records }));
} finally {
  await fixture.dispose();
}
