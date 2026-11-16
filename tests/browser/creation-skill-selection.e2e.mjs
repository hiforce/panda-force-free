import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeSkillPackage } from "../support/native-skill-package.js";
const out = ".artifacts/creation-skill-category/screens";
await mkdir(out, { recursive: true });
for (const [engine, width, locale, theme] of [
  [chromium, 1440, "en", "silk"],
  [webkit, 390, "zh-CN", "aurora"],
  [webkit, 320, "zh-CN", "aurora"],
]) {
  const app = await createAppFixture({
      applicationCreation: true,
      models: [
        {
          id: "gpt-fixture",
          model: "gpt-fixture",
          isDefault: true,
          displayName: "Fixture model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
      ],
    }),
    browser = await engine.launch(),
    context = await browser.newContext({ viewport: { width, height: 1050 }, locale });
  let page,
    releaseSkills = () => {};
  try {
    await context.addInitScript((theme) => {
      if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
    }, theme);
    await app.signIn(context);
    const pack = await nativeSkillPackage("selection.review-kit");
    const post = async (path, data) => {
      const r = await context.request.post(app.base + path, { data, headers: { Origin: app.base } });
      assert.ok(r.ok(), await r.text());
      return r.json();
    };
    const review = await post("/api/skill-packs/review", {
      content: pack.content,
      name: "writing.skill.json",
      selected: ["blog-outline", "brand-voice"],
    });
    await post("/api/skill-packs/install", {
      content: pack.content,
      name: "writing.skill.json",
      approval: {
        id: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        capabilities: review.capabilities,
        selected: review.selected,
      },
    });
    const r = await context.request.get(app.base + "/api/personal/document-creations/options"),
      options = await r.json();
    assert.equal(options.state, "ready");
    let workspace = await (await context.request.get(app.base + "/api/skill-workspace")).json();
    const personalCategory = "custom-" + randomUUID();
    const organize = async (command) => {
      workspace = await post("/api/skill-workspace/commands", {
        operationId: randomUUID(),
        expectedRevision: workspace.revision,
        command,
      });
    };
    await organize({ type: "create-category", id: personalCategory, name: { en: "My picks", "zh-CN": "我的常用" } });
    const categoryCatalog = await (
      await context.request.get(app.base + "/api/template-catalog?registry=skills&view=versions&limit=100")
    ).json();
    for (const id of ["software-prd", "research-digest"]) {
      const item = categoryCatalog.templates.find((value) => value.reference.exportId === id);
      assert.ok(item);
      await organize({ type: "assign", key: item.key, categoryIds: [personalCategory] });
    }
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("page error", error.message);
    });
    await page.goto(app.base + "/skills/writing");
    await page.locator('[data-template-key*="selection.review-kit:writing:"]').waitFor();
    assert.equal(
      await page
        .locator('[data-template-key*="panda-force.document-creation"], [data-template-key*="panda-force.writing"]')
        .count(),
      0,
    );
    await page.goto(app.base + "/create");
    let denyCategories = true;
    await page.route(/\/api\/skill-workspace(?:\?view=categories)?$/, async (route) => {
      if (denyCategories) return route.fulfill({ status: 503, json: { messageId: "skillWorkspace.unavailable" } });
      await route.continue();
    });
    let denySkills = true;
    const skillGate = new Promise((resolve) => {
      releaseSkills = resolve;
    });
    await page.route("**/api/skill-packs?*", async (route) => {
      await skillGate;
      if (denySkills) return route.fulfill({ status: 503, json: { messageId: "plugins.packageUnavailable" } });
      await route.continue();
    });
    await page.locator("#gadgetDocumentPrompt").fill("A brief with optional skills.");
    await page.goto(app.base + "/documents?project=personal");
    await page.locator('.documents-heading [data-authoring-action="new-ai"]').click();
    const dialog = page.locator(".creation-dialog[open]");
    await dialog.locator("[data-creation-submit]:enabled").waitFor();
    assert.equal(await dialog.locator(".creation-skill").count(), 0);
    assert.match(
      await dialog.locator(".creation-skill-empty").innerText(),
      locale === "en" ? /No skills selected/ : /尚未选择技能/,
    );
    await page.screenshot({ path: `${out}/empty-${width}.png` });
    await dialog.locator("[data-skill-browser-open]").click();
    const picker = page.locator(".creation-skill-browser[open]");
    await picker.locator(".creation-skill-options .creation-skill-picker-hint").waitFor();
    await picker.locator("[data-skill-search]").fill("PRD");
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    await dialog.locator("[data-skill-browser-open]").click();
    assert.equal(await picker.locator("[data-skill-search]").inputValue(), "PRD");
    await page.screenshot({ path: `${out}/loading-${width}.png` });
    releaseSkills();
    await picker.locator("[data-skill-browser-error]:visible").waitFor();
    denySkills = false;
    await picker.locator('[data-skill-action="more"]').click();
    await picker.locator("[data-skill-category-retry]").waitFor();
    denyCategories = false;
    await picker.locator("[data-skill-category-retry]").click();
    await picker.locator(`[data-skill-category="${personalCategory}"]`).waitFor();
    assert.equal(await picker.locator("[data-skill-category-retry]").count(), 0);
    await picker.locator('[data-skill-id="software-prd"]').waitFor();
    await picker.locator("[data-skill-search]").fill("");
    await picker.locator(`[data-skill-package="${pack.pack.manifest.id}"][data-skill-id="blog-outline"]`).waitFor();
    assert.equal(await picker.locator("[data-skill-browser-error]").isVisible(), false);
    const parentNotice = dialog.locator("[data-creation-notice]");
    assert.notEqual(await parentNotice.getAttribute("data-error"), "true");
    if (await parentNotice.isVisible())
      assert.match(await parentNotice.innerText(), locale === "en" ? /unfinished brief has been restored/ : /已恢复/);
    assert.equal(await dialog.locator(".creation-skill-options").count(), 0);
    const browserBox = await picker.boundingBox(),
      parentBox = await dialog.boundingBox();
    assert.ok(width > 700 ? browserBox.width > parentBox.width + 150 : Math.abs(browserBox.width - width) < 1);
    assert.ok(browserBox.height > 850);
    assert.equal(await picker.evaluate((node) => node.matches(":modal")), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement.closest(".creation-skill-browser")), true);
    assert.equal(
      await picker
        .locator('[data-skill-package="panda-force.document-creation"], [data-skill-package="panda-force.writing"]')
        .count(),
      0,
    );
    const catalogResponse = await context.request.get(
      app.base + "/api/template-catalog?registry=skills&view=versions&limit=100",
    );
    assert.ok(catalogResponse.ok());
    const catalog = await catalogResponse.json();
    assert.equal(
      catalog.templates.some((item) =>
        ["panda-force.document-creation", "panda-force.writing"].includes(item.reference.packageId),
      ),
      false,
    );
    assert.ok(
      catalog.templates.some(
        (item) => item.reference.packageId === pack.pack.manifest.id && item.reference.exportId === "writing",
      ),
    );
    const cards = picker.locator(".creation-skill-option");
    assert.equal(await picker.locator("[data-skill-category]").first().getAttribute("data-skill-category"), "all");
    assert.equal(await picker.locator('[data-skill-category="all"]').getAttribute("aria-pressed"), "false");
    assert.equal(await picker.locator('[data-skill-category="writing"]').getAttribute("aria-pressed"), "true");
    assert.ok((await cards.count()) >= 8);
    assert.equal(await picker.locator('[data-skill-id="research-digest"]').count(), 0);
    await page.screenshot({ path: `${out}/default-writing-${width}.png` });
    await picker.locator('[data-skill-category="research"]').focus();
    await page.keyboard.press("Enter");
    assert.equal(await picker.locator('[data-skill-id="software-prd"]').count(), 0);
    await picker.locator('[data-skill-id="research-digest"]').click();
    assert.equal(await dialog.locator('[data-selected-skill="research-digest"]').count(), 1);
    await picker.locator("[data-skill-search]").fill("PRD");
    await picker.locator(".creation-skill-options .creation-skill-picker-hint").waitFor();
    await picker.locator('[data-skill-category="writing"]').click();
    assert.equal(await picker.locator("[data-skill-search]").inputValue(), "PRD");
    await picker.locator('[data-skill-id="software-prd"]').click();
    assert.equal(await dialog.locator(".creation-skill").count(), 2);
    await picker.locator(`[data-skill-category="${personalCategory}"]`).click();
    assert.equal(await cards.count(), 1);
    await picker.locator("[data-skill-search]").fill("");
    assert.equal(await cards.count(), 2);
    await page.screenshot({ path: `${out}/personal-category-${width}.png` });
    await picker.locator("[data-skill-browser-close]").last().click();
    await dialog.locator("[data-skill-browser-open]").click();
    assert.equal(
      await picker.locator(`[data-skill-category="${personalCategory}"]`).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await dialog.locator(".creation-skill").count(), 2);
    await picker.locator('[data-skill-id="research-digest"]').click();
    await picker.locator('[data-skill-id="software-prd"]').click();
    assert.equal(await dialog.locator(".creation-skill").count(), 0);
    await picker.locator('[data-skill-category="all"]').click();
    assert.ok((await cards.count()) >= 18);
    assert.equal(await cards.locator(".template-cover").count(), await cards.count());
    const columns = await picker
      .locator(".creation-skill-options")
      .evaluate((root) => getComputedStyle(root).gridTemplateColumns.split(" ").length);
    assert.ok(width > 700 ? columns >= 5 : columns === 2);
    assert.equal(
      await cards.evaluateAll((items) =>
        items.every((card) => {
          const button = card.querySelector(".creation-skill-choose"),
            box = button.getBoundingClientRect();
          return [...button.children].every((child) => child.getBoundingClientRect().bottom <= box.bottom + 1);
        }),
      ),
      true,
    );
    await page.screenshot({ path: `${out}/picker-${width}.png` });
    await picker.locator('[data-skill-id="software-prd"]').click();
    assert.match(
      await picker.locator("[data-skill-browser-count]").innerText(),
      locale === "en" ? /1 skill selected/ : /已选择 1 项技能/,
    );
    assert.equal(await picker.isVisible(), true);
    await page.screenshot({ path: `${out}/browser-selected-${width}.png` });
    await picker.locator('[data-skill-id="software-prd"]').click();
    const scroller = picker.locator(".creation-skill-browser-scroll");
    await scroller.evaluate((node) => {
      node.scrollTop = 250;
    });
    const scrollTop = await scroller.evaluate((node) => node.scrollTop);
    await picker.locator("[data-skill-browser-close]").last().click();
    await dialog.locator("[data-skill-browser-open]").click();
    assert.ok(Math.abs((await scroller.evaluate((node) => node.scrollTop)) - scrollTop) < 2);
    await picker.locator("[data-skill-search]").fill("PRD");
    const prd = picker
      .locator(".creation-skill-option")
      .filter({ has: page.locator('[data-skill-id="software-prd"]') });
    assert.equal(
      await prd.locator(".creation-skill-option-title").innerText(),
      locale === "en" ? "Software PRD" : "软件需求 PRD",
    );
    assert.equal(await prd.locator("small").innerText(), "v1.0.0");
    assert.equal(await prd.locator("p").count(), 0);
    const art = await prd.locator(".skill-artwork").innerHTML();
    await prd.locator('[data-skill-action="details"]').click();
    const detail = page.locator(".creation-skill-detail[open]");
    await detail.waitFor();
    assert.match(
      await detail.innerText(),
      locale === "en" ? /Deliverable: an editable document/ : /交付物：可编辑文档/,
    );
    assert.equal(await dialog.locator(".creation-skill").count(), 0);
    assert.equal(await dialog.locator('[name="prompt"]').inputValue(), "A brief with optional skills.");
    assert.equal(await detail.locator(".skill-artwork").innerHTML(), art);
    await page.screenshot({ path: `${out}/details-${width}.png` });
    await page.keyboard.press("Escape");
    await detail.waitFor({ state: "detached" });
    assert.equal(await picker.locator("[data-skill-search]").inputValue(), "PRD");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.skillAction), "details");
    await prd.locator('[data-skill-action="add"]').click();
    assert.equal(await dialog.locator(".creation-skill-thumbnail .skill-artwork").innerHTML(), art);
    assert.equal(await prd.locator('[data-skill-action="add"]').getAttribute("aria-pressed"), "true");
    await picker.locator("[data-skill-browser-close]").last().click();
    await page.screenshot({ path: `${out}/prd-selected-${width}.png` });
    await dialog.locator('.creation-skill [data-skill-action="details"]').click();
    await detail.locator("[data-skill-detail-close]").click();
    assert.equal(await dialog.locator(".creation-skill").count(), 1);
    await dialog.locator("[data-skill-browser-open]").click();
    await prd.locator('[data-skill-action="add"]').click();
    assert.equal(await dialog.locator(".creation-skill").count(), 0);
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.hasAttribute("data-skill-browser-open")), true);
    await dialog.locator("[data-skill-browser-open]").click();
    await picker.locator("[data-skill-search]").fill(locale === "en" ? "Blog" : "博客");
    await picker.locator('[data-skill-action="add"][data-skill-id="blog-outline"]').click();
    assert.equal(await dialog.locator(".creation-skill").count(), 1);
    assert.equal(
      await dialog.locator(".creation-skill-copy strong").innerText(),
      locale === "en" ? "Blog outline" : "博客结构",
    );
    await picker.locator("[data-skill-browser-close]").last().click();
    await dialog.locator(".creation-skill summary").click();
    await dialog.locator('[data-skill-parameter="audience"]').fill("New users");
    await dialog.locator("[data-skill-browser-open]").click();
    await picker.locator("[data-skill-search]").fill(locale === "en" ? "Brand" : "清晰");
    await picker.locator('[data-skill-action="add"][data-skill-id="brand-voice"]').click();
    await picker.locator("[data-skill-browser-close]").last().click();
    await dialog.locator('[data-skill-action="up"][data-index="1"]').click();
    assert.deepEqual(
      await dialog.locator("[data-selected-skill]").evaluateAll((nodes) => nodes.map((n) => n.dataset.selectedSkill)),
      ["brand-voice", "blog-outline"],
    );
    assert.equal(await dialog.locator('[data-skill-parameter="audience"]').inputValue(), "New users");
    const geometry = await dialog.locator(".creation-skills").evaluate((root) => {
      const section = root.getBoundingClientRect(),
        picker = root.querySelector("[data-skill-browser-open]").getBoundingClientRect();
      return {
        section: section.toJSON(),
        picker: picker.toJSON(),
        controls: [...root.querySelectorAll(".creation-skill-actions button")].map((b) =>
          b.getBoundingClientRect().toJSON(),
        ),
        headers: [...root.querySelectorAll(".creation-skill-header")].map((row) =>
          [...row.children]
            .filter((e) => getComputedStyle(e).display !== "none")
            .map((e) => e.getBoundingClientRect().toJSON()),
        ),
      };
    });
    assert.ok(
      Math.abs(geometry.section.left - geometry.picker.left) < 1 &&
        Math.abs(geometry.section.right - geometry.picker.right) < 1,
    );
    assert.ok(
      geometry.controls.every((b) => b.width >= (width > 700 ? 40 : 44) && b.height >= (width > 700 ? 40 : 44)),
    );
    if (width > 700)
      for (const cells of geometry.headers)
        assert.ok(
          Math.max(...cells.map((c) => c.y + c.height / 2)) - Math.min(...cells.map((c) => c.y + c.height / 2)) < 1,
        );
    await page.screenshot({ path: `${out}/selected-${width}.png` });
    await dialog.locator("[data-creation-close]").click();
    await page.reload();
    await page.locator('.documents-heading [data-authoring-action="new-ai"]').click();
    await dialog.locator('[data-selected-skill="blog-outline"]').waitFor();
    assert.equal(await dialog.locator(".creation-skill").count(), 2);
    while (await dialog.locator('[data-skill-action="remove"]').count())
      await dialog.locator('[data-skill-action="remove"]').first().click();
    await dialog.locator("[data-creation-close]").click();
    await page.locator('.documents-heading [data-authoring-action="new-ai"]').click();
    await dialog.locator(".creation-skill-empty").waitFor();
    assert.equal(await dialog.locator(".creation-skill").count(), 0);
    await dialog.locator("[data-creation-close]").click();
    await page.evaluate(
      ({ base, chosen }) => {
        const key = Object.keys(localStorage).find(
          (k) => k.startsWith("panda-force-creation:") && k.includes('"personal"'),
        );
        if (!key) throw new Error("Missing creation draft");
        const draft = JSON.parse(localStorage.getItem(key));
        draft.selections = [base, chosen];
        delete draft.skillsVersion;
        draft.pending = null;
        draft.prompt = "Legacy brief";
        localStorage.setItem(key, JSON.stringify(draft));
      },
      {
        base: options.defaultWorkflow,
        chosen: {
          packageId: pack.pack.manifest.id,
          version: pack.pack.manifest.version,
          digest: pack.pack.digest,
          id: "brand-voice",
          parameters: {},
        },
      },
    );
    await page.reload();
    await page.locator('.documents-heading [data-authoring-action="new-ai"]').click();
    await dialog.locator('[data-selected-skill="brand-voice"]').waitFor();
    assert.equal(await dialog.locator(".creation-skill").count(), 1);
    assert.equal(await dialog.locator('[name="prompt"]').inputValue(), "Legacy brief");
    await dialog.locator('[data-skill-action="remove"]').click();
    const submitted = page.waitForResponse(
      (r) => r.url().endsWith("/api/personal/document-creations") && r.request().method() === "POST",
    );
    await dialog.locator("[data-creation-submit]:enabled").click();
    const accepted = await submitted;
    assert.deepEqual(accepted.request().postDataJSON().selections, []);
    assert.equal(accepted.status(), 202);
    workspace = await (await context.request.get(app.base + "/api/skill-workspace")).json();
    await organize({ type: "rename-category", id: "writing", name: { en: "Drafting", "zh-CN": "文稿" } });
    await dialog.locator("[data-skill-browser-open]").click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector('[data-skill-category="writing"] [data-i18n-ignore]')?.textContent === expected,
      locale === "en" ? "Drafting" : "文稿",
    );
    assert.equal(await picker.locator('[data-skill-category="writing"]').getAttribute("aria-pressed"), "true");
    await picker.locator("[data-skill-browser-close]").last().click();
    await organize({ type: "delete-category", id: "writing" });
    await dialog.locator("[data-skill-browser-open]").click();
    await picker.locator('[data-skill-category="writing"]').waitFor({ state: "detached" });
    assert.equal(await picker.locator('[data-skill-category="all"]').getAttribute("aria-pressed"), "false");
    assert.equal(await picker.locator('[data-skill-category="research"]').getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: `${out}/configured-fallback-${width}.png` });
    await picker.locator("[data-skill-browser-close]").last().click();
    assert.equal(await dialog.locator(".creation-skill").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page) await page.screenshot({ path: `${out}/failed-${width}.png` });
    throw error;
  } finally {
    releaseSkills();
    await context.close();
    await browser.close();
    await app.stop();
  }
}
