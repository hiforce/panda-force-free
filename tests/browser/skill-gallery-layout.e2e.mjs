import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { encodeSkillBundle } from "../../src/server/skills/storage/codec.js";

const fixture = await createAppFixture(),
  out = ".artifacts/skill-gallery-layout",
  measurements = [];
await mkdir(out, { recursive: true });
try {
  const installContext = await (await chromium.launch({ headless: true })).newContext();
  const installBrowser = installContext.browser();
  try {
    await fixture.signIn(installContext);
    const initial = await nativeSkillPackage("example.editorial-writing"),
      base = initial.pack.manifest;
    const image = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#e9e7dd"/><circle cx="510" cy="300" r="240" fill="#f5f2eb"/><rect x="206" y="86" width="470" height="405" rx="14" fill="#c3d4ca" transform="rotate(-8 441 288)"/><rect x="262" y="66" width="470" height="420" rx="14" fill="#fffdf7" transform="rotate(4 497 276)"/><path d="M325 155h190M325 211h295M325 246h238M325 314h276M325 349h226" stroke="#62867e" stroke-width="10" stroke-linecap="round"/><rect x="533" y="398" width="231" height="91" rx="14" fill="#244c52"/><path d="m566 443 15 15 32-35m30 16h82" stroke="#bbcec2" stroke-width="7" stroke-linecap="round" fill="none"/></svg>',
      ),
    )
      .webp({ quality: 90 })
      .toBuffer();
    for (const version of ["1.0.0", "1.0.1"]) {
      const manifest = structuredClone(base);
      manifest.version = version;
      manifest.files.push("artwork/editorial.webp");
      const titles = [
        ["Software PRD Writer", "软件需求 PRD 写作"],
        ["Product Brief", "产品简报"],
        ["Release Notes", "版本更新说明"],
        ["API Reference", "API 参考文档"],
        ["Technical Guide", "技术方案写作"],
        ["User Stories", "用户故事与验收"],
        ["Design Review", "设计评审意见"],
        ["Engineering Decisions", "工程决策记录"],
      ];
      manifest.skills = titles.map(([en, zh], index) => ({
        ...structuredClone(base.skills[1]),
        id: "writing-" + index,
        category: "writing",
        name: { en, "zh-CN": zh },
        description: {
          en: "Turn a clear brief into useful writing, with concrete decisions and reviewable next steps.",
          "zh-CN": "从背景资料梳理重点，形成清晰、有依据、便于评审的内容。",
        },
        ...(index % 2 === 0
          ? {
              cover: {
                path: "artwork/editorial.webp",
                alt: { en: "Editorial requirements illustration", "zh-CN": "需求文档插画" },
              },
            }
          : {}),
      }));
      const resources = initial.pack.resources.map((file) => ({
        path: file.path,
        bytes: initial.pack.read(file.path),
      }));
      resources.push({ path: "artwork/editorial.webp", bytes: image });
      const pack = await verifySkillResources(new TextEncoder().encode(JSON.stringify(manifest)), resources),
        content = new TextDecoder().decode(encodeSkillBundle(pack));
      const post = async (path, data) => {
        const response = await installContext.request.post(fixture.base + path, { data });
        assert.ok(response.ok(), await response.text());
        return response.json();
      };
      const review = await post("/api/skill-packs/review", {
        content,
        name: "writing.skill.json",
        selected: manifest.skills.map((skill) => skill.id),
      });
      await post("/api/skill-packs/install", {
        content,
        name: "writing.skill.json",
        approval: {
          id: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
          capabilities: review.capabilities,
        },
      });
    }
  } finally {
    await installBrowser.close();
  }
  for (const [engine, width, locale, theme] of [
    [chromium, 1440, "en", "silk"],
    [webkit, 390, "en", "aurora"],
    [webkit, 390, "zh-CN", "silk"],
    [webkit, 320, "zh-CN", "dark"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({ viewport: { width, height: 960 }, locale });
    try {
      await context.addInitScript((theme) => {
        if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", theme);
      }, theme);
      await fixture.signIn(context);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(fixture.base + "/skills/writing");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(() =>
          performance.getEntriesByType("resource").some((entry) => {
            const url = new URL(entry.name);
            return url.pathname === "/app.bundle.js" && /^[a-f0-9]{64}$/.test(url.searchParams.get("v") || "");
          }),
        ),
        true,
        "The bootstrap must request the exact current application entry",
      );
      await page.locator("[data-template-search]").fill("example.editorial-writing");
      await page.waitForFunction(() => document.querySelectorAll(".template-card").length === 8);
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".template-cover img")].every((img) => {
          const box = img.getBoundingClientRect();
          return box.top >= innerHeight || box.bottom <= 0 || (img.complete && img.naturalWidth > 0);
        }),
      );
      const geometry = await page.locator(".template-card").evaluateAll((cards) =>
        cards.map((card) => {
          const r = card.getBoundingClientRect(),
            cover = card.querySelector(".template-cover").getBoundingClientRect(),
            author = card.querySelector(".template-card-author").getBoundingClientRect(),
            version = card.querySelector(".template-state").getBoundingClientRect();
          return {
            width: r.width,
            height: r.height,
            top: r.top,
            media: card.querySelectorAll(".template-cover > svg,.template-cover > img").length,
            coverHeight: cover.height,
            attributionFits: author.right <= version.left && version.right <= r.right - 8,
          };
        }),
      );
      assert.equal(geometry.length, 8);
      assert.ok(geometry.every((card) => card.media === 1));
      assert.ok(
        geometry.every((card) => card.attributionFits),
        "Attribution and version must retain separate space",
      );
      assert.ok(geometry.every((card) => card.height < (width < 360 ? 360 : width < 768 ? 290 : 350)));
      if (width >= 360 && width < 768) {
        assert.equal(geometry[0].top, geometry[1].top);
        assert.ok(geometry[0].width < 200);
        assert.ok(geometry.every((card) => card.height >= 215 && card.height <= 245));
      }
      if (width < 360) assert.ok(geometry[1].top > geometry[0].top);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/gallery-${theme}-${width}.png` });
      const all = await (
        await context.request.get(
          fixture.base +
            "/api/template-catalog?registry=skills&view=versions&limit=100&search=example.editorial-writing",
        )
      ).json();
      assert.equal(all.templates.length, 16);
      const buttons = page.locator(".template-card");
      assert.equal(await buttons.count(), 8);
      await buttons.last().scrollIntoViewIfNeeded();
      if (width < 768) {
        const boxes = await page.evaluate(() => ({
          nav: document.querySelector(".skills-mobile-navigation").getBoundingClientRect().bottom,
          heading: document.querySelector(".template-manager-heading").getBoundingClientRect().top,
        }));
        assert.ok(boxes.nav <= boxes.heading + 1, "Categories must remain before the heading when the gallery scrolls");
      }
      await buttons.first().scrollIntoViewIfNeeded();
      await buttons.first().focus();
      assert.equal(
        await buttons.first().evaluate((card) => parseFloat(getComputedStyle(card).outlineWidth) >= 2),
        true,
        "Keyboard focus must be distinct from the restrained pointer hover",
      );
      await buttons.first().click();
      const detail = page.locator("#managedTemplateDialog");
      await detail.locator('[data-template-detail="versions"]:enabled').click();
      await page.waitForFunction(() => document.querySelectorAll(".template-version-row").length === 2);
      await detail.locator('[data-template-detail="close"]').click();
      assert.deepEqual(errors, []);
      measurements.push({ browser: engine.name(), width, theme, cards: geometry });
    } finally {
      await context.close();
      await browser.close();
    }
  }
  // A rejected or stale stylesheet must recover before any application is revealed.
  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en" });
    await fixture.signIn(context);
    const page = await context.newPage();
    let replaced = false;
    await page.route("**/packages.css*", (route) => {
      if (!replaced && route.request().resourceType() === "stylesheet") {
        replaced = true;
        return route.fulfill({ status: 200, contentType: "text/css", body: ".template-card{height:900px}" });
      }
      return route.continue();
    });
    await page.goto(fixture.base + "/skills/writing");
    await page.locator(".template-card").first().waitFor();
    assert.ok(replaced);
    assert.equal(await page.locator('link[data-pf-recovered-style="/packages.css"]').count(), 1);
    assert.ok((await page.locator(".template-card").first().boundingBox()).height < 290);
    assert.equal(await page.locator('[data-template-action="article"]').textContent(), "New skill");
    await page.screenshot({ path: `${out}/recovered-styles-390.png` });
    await page.route("**/packages.css*", (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: ".template-card{height:900px}" }),
    );
    await page.reload();
    await page.locator("#authRetryButton").waitFor({ state: "visible" });
    assert.equal(await page.locator("#app").isVisible(), false);
    await context.close();
  } finally {
    await browser.close();
  }
  await writeFile(out + "/measurements.json", JSON.stringify(measurements, null, 2) + "\n");
  console.log(
    "Compact PC/H5 galleries retain one version per skill, single-media covers and normal-flow categories; stale styles recover or remain behind a clear retry state.",
  );
} finally {
  await fixture.dispose();
}
