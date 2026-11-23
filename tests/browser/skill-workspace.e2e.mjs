import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/configured-skill-categories/library-screens",
  records = [];
await mkdir(out, { recursive: true });
for (const [engine, width, locale, theme] of [
  [chromium, 1440, "en", "silk"],
  [webkit, 390, "zh-CN", "aurora"],
  [webkit, 320, "zh-CN", "aurora"],
]) {
  const app = await createAppFixture(),
    browser = await engine.launch(),
    context = await browser.newContext({ viewport: { width, height: 1050 }, locale });
  let debugPage;
  try {
    await context.addInitScript((theme) => {
      if (window === window.top && /^https?:$/.test(location.protocol))
        localStorage.setItem("panda-force-theme", theme);
    }, theme);
    await app.signIn(context);
    const page = await context.newPage(),
      errors = [];
    debugPage = page;
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => errors.push(e.message));
    const read = async () => {
      const r = await context.request.get(app.base + "/api/skill-workspace");
      assert.ok(r.ok(), await r.text());
      return r.json();
    };
    const management = page.locator("[data-template-menu]");
    async function manage(action) {
      await management.locator("summary").click();
      await management.locator(`[data-skills-action="${action}"]`).click();
    }
    async function selectCategory(category) {
      const filters = page.locator('[data-template-action="filters"]');
      if ((await filters.isVisible()) && (await filters.getAttribute("aria-expanded")) !== "true") {
        await filters.click();
      }
      await page.locator("[data-skills-select]").selectOption(category);
    }
    await page.goto(app.base + "/skills");
    await page.locator(".template-card").first().waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-template-action="pin"]')?.disabled);
    assert.deepEqual(
      (await read()).pins.map((p) => p.id),
      ["writing", "slides", "image", "web", "video"],
    );
    assert.equal(await page.locator(".workbench-navigation [data-skills-category]").count(), 0);
    assert.equal(
      await page
        .locator('[data-skills-select] option[value="site"], [data-skills-select] option[value="channel"]')
        .count(),
      0,
    );
    assert.equal(
      await page
        .locator(
          '[data-template-type] option[value="panda.site-theme"], [data-template-type] option[value="panda.channel-format"]',
        )
        .count(),
      0,
    );
    assert.equal(await page.locator('[data-template-action="drafts"]').isVisible(), false);
    const catalog = await context.request.get(app.base + "/api/template-catalog?domain=skills&limit=100");
    assert.ok(catalog.ok());
    assert.ok(
      (await catalog.json()).templates.every(
        (item) => !["panda.site-theme", "panda.channel-format"].includes(item.templateType),
      ),
    );
    await page.screenshot({ path: `${out}/all-${width}.png` });
    await manage("categories");
    const dialog = page.locator("#skillWorkspaceDialog[open]");
    await dialog.locator('[data-skills-action="new-category"]').click();
    await dialog.locator('input[name="zh"]').fill("产品");
    await dialog.locator('input[name="en"]').fill("Product");
    await dialog.locator('[data-skills-action="save-category"]').click();
    await dialog.locator(".skills-category-list").waitFor();
    const category = (await read()).categories.find((c) => c.name.en === "Product");
    assert.ok(category);
    assert.equal(await dialog.locator("[data-skills-edit-category]").count(), (await read()).categories.length);
    await dialog.locator('[data-skills-edit-category="writing"]').click();
    await dialog.locator('input[name="zh"]').fill("文稿");
    await dialog.locator('input[name="en"]').fill("Drafting");
    await dialog.locator('[data-skills-action="save-category"]').click();
    await dialog.locator(".skills-category-list").waitFor();
    assert.equal((await read()).categories.find((value) => value.id === "writing").name.en, "Drafting");
    await page.screenshot({ path: `${out}/configured-categories-${width}.png` });
    await dialog.locator('header [data-skills-action="close"]').click();
    await manage("pins");
    await dialog.locator(`[data-skills-pin-category="${category.id}"]`).check();
    await page.waitForFunction(
      (id) => document.querySelectorAll(`[data-skills-category="${id}"]`).length > 0,
      category.id,
    );
    await page.waitForFunction(
      () => document.querySelector("#skillWorkspaceDialog")?.getAttribute("aria-busy") === "false",
    );
    const last = (await read()).pins.length - 1;
    await dialog.locator(`[data-skills-move="${last}"][data-direction="-1"]`).click();
    await page.waitForFunction(
      () => document.querySelector("#skillWorkspaceDialog")?.getAttribute("aria-busy") === "false",
    );
    assert.equal((await read()).pins[last - 1].id, category.id);
    await page.screenshot({ path: `${out}/pins-${width}.png` });
    await page.keyboard.press("Escape");
    assert.equal(await management.locator("summary").evaluate((element) => element === document.activeElement), true);
    await selectCategory("writing");
    const card = page
      .locator(".template-card-shell")
      .filter({ hasText: locale === "en" ? "Software PRD" : "软件需求 PRD" });
    await card.locator('[data-template-action="pin"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.skills-card-pin[aria-pressed="true"]').length === 1);
    const search = page.locator("[data-template-search]");
    await search.fill("PRD");
    await selectCategory("slides");
    await selectCategory("writing");
    assert.equal(await search.inputValue(), "PRD");
    await search.fill("");
    const pinned = (await read()).pins.find((p) => p.kind === "skill");
    assert.ok(pinned);
    assert.equal(pinned.version, "1.0.0");
    await card.locator(".template-card").click();
    const detail = page.locator("#managedTemplateDialog[open]");
    await detail.locator('[data-template-detail="categorize"]:enabled').waitFor();
    await detail.locator('[data-template-detail="categorize"]').click();
    await dialog.locator(`[data-skills-assignment="${category.id}"]`).check();
    await dialog.locator('[data-skills-action="save-assignment"]').click();
    await dialog.waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await selectCategory(category.id);
    await page.waitForURL("**/skills/" + category.id);
    await page.locator(".template-card").waitFor();
    assert.equal(await page.locator(".template-card").count(), 1);
    await page.screenshot({ path: `${out}/personal-${width}.png` });
    await page.reload();
    await page.locator(".template-card").waitFor();
    assert.equal(await page.locator(".template-card").count(), 1);
    if (width < 901) {
      await manage("navigation");
      await page.screenshot({ path: `${out}/navigation-${width}.png` });
      await dialog.locator(`[data-skills-key="${pinned.key}"]`).click();
    } else await page.locator(`[data-skills-navigation] [data-skills-key="${pinned.key}"]`).click();
    await detail.locator("#managedTemplateTitle").waitFor();
    assert.match(await detail.locator("#managedTemplateTitle").innerText(), /PRD/);
    await page.keyboard.press("Escape");
    let drop = true;
    const mutations = [];
    await page.route("**/api/skill-workspace/commands", async (route) => {
      mutations.push(route.request().postDataJSON());
      if (drop) {
        drop = false;
        await route.fetch();
        return route.abort();
      }
      return route.continue();
    });
    await page.locator(".skills-card-pin").click();
    await page.locator("[data-skills-notice]:visible").waitFor();
    await page.waitForFunction(() => !document.querySelector("[data-skills-notice] button")?.disabled);
    await page.locator('[data-skills-notice] [data-skills-action="retry"]').click();
    await page.locator("[data-skills-notice]").waitFor({ state: "hidden" });
    assert.equal(mutations.length, 2);
    assert.deepEqual(mutations[0], mutations[1]);
    assert.equal((await read()).pins.filter((p) => p.kind === "skill").length, 0);
    await page.unroute("**/api/skill-workspace/commands");
    await manage("categories");
    await dialog.locator(`[data-skills-edit-category="${category.id}"]`).click();
    await dialog.locator('input[name="en"]').fill("Product planning");
    await dialog.locator('[data-skills-action="save-category"]').click();
    await dialog.locator(".skills-category-list").waitFor();
    assert.match(await dialog.innerText(), locale === "en" ? /Product planning/ : /产品/);
    await dialog.locator(`[data-skills-delete-category="${category.id}"]`).click();
    await dialog.locator('[data-skills-action="confirm-delete"]').click();
    await page.waitForURL("**/skills");
    assert.equal(
      (await read()).categories.some((c) => c.id === category.id),
      false,
    );
    assert.equal(
      Object.values((await read()).assignments).some((ids) => ids.includes(category.id)),
      false,
    );
    assert.equal(
      Object.values((await read()).assignments).some((ids) => ids.includes("writing")),
      true,
    );
    await dialog.locator(".skills-category-list").waitFor();
    await dialog.locator('[data-skills-delete-category="writing"]').click();
    await dialog.locator('[data-skills-action="confirm-delete"]').click();
    await dialog.locator(".skills-category-list").waitFor();
    assert.equal(
      (await read()).categories.some((value) => value.id === "writing"),
      false,
    );
    await dialog.locator('header [data-skills-action="close"]').click();
    await page.reload();
    await page.locator(".template-card").first().waitFor();
    assert.equal(await page.locator('[data-skills-select] option[value="writing"]').count(), 0);
    await app.stop();
    await app.start();
    assert.equal((await read()).revision > 0, true);
    assert.equal(
      (await read()).pins.some((p) => p.id === category.id),
      false,
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    records.push({ width, locale, status: "passed", serverPersisted: true, exactReplay: true });
  } catch (error) {
    if (debugPage) {
      await debugPage.screenshot({ path: `${out}/failure-${width}.png` });
      console.log(await debugPage.locator("#skillWorkspaceDialog").innerText());
    }
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await app.dispose();
  }
}
await mkdir(".artifacts/skill-workspace", { recursive: true });
await writeFile(".artifacts/skill-workspace/verification.json", JSON.stringify(records, null, 2));
console.log(JSON.stringify(records));
