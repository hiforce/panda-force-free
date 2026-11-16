import { portableFixture, editPortableFixture } from "../support/portable-templates.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { verifySkillResources } from "../../src/shared/skills/resources.js";
import { encodeSkillBundle, decodeSkillBundle } from "../../src/server/skills/storage/codec.js";

const fixture = await createAppFixture();
await mkdir(".artifacts/skill-covers", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
      await fixture.signIn(context);
      const api = async (path, data) => {
        const response =
          data === undefined
            ? await context.request.get(fixture.base + path)
            : await context.request.post(fixture.base + path, { data, headers: { Origin: fixture.base } });
        assert.ok(response.ok(), path + ": " + (await response.text()));
        return response.json();
      };
      const initial = await nativeSkillPackage("example.cover-review-" + width);
      const manifest = structuredClone(initial.pack.manifest),
        base = structuredClone(manifest.skills[1]);
      manifest.skills = [
        [
          "writing",
          "Software PRD Writer",
          "软件需求 PRD 写作",
          "Turn product intent into a clear, reviewable product requirements document.",
          "把产品目标整理成清晰、可验收的需求说明。",
          "document",
        ],
        [
          "research",
          "Evidence Brief",
          "研究与论据",
          "Build a concise brief with traceable evidence.",
          "从资料中整理有出处、可核对的研究结论。",
          "document",
        ],
        [
          "slides",
          "Executive Deck",
          "高管汇报",
          "Tell a focused story with confident slide layouts.",
          "用克制的页面布局呈现重点与决策。",
          "slides",
        ],
        [
          "image",
          "Editorial Illustration",
          "编辑插画",
          "Create a visual explanation with a considered palette.",
          "用统一配色与构图解释复杂概念。",
          "image",
        ],
        [
          "web",
          "Personal Journal",
          "个人主页",
          "Create a calm home for stories and ideas.",
          "为文字与想法设计有气质的展示空间。",
          "web",
        ],
        [
          "video",
          "Story in Motion",
          "短片叙事",
          "Shape a clear visual narrative from your brief.",
          "从创作意图出发，组织清晰的镜头叙事。",
          "video",
        ],
      ].map(([category, en, zh, description, descriptionZh, output]) => ({
        ...base,
        id: category,
        category,
        name: { en, "zh-CN": zh },
        description: { en: description, "zh-CN": descriptionZh, fr: "Description traduite sans nom traduit." },
        outputTypes: [output],
        composition: { ...base.composition, appliesTo: [output] },
      }));
      // The author supplies raster artwork; executable SVG and arbitrary remote artwork are never admitted.
      const artwork = await sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#ebe5d8"/><rect x="180" y="100" width="840" height="560" rx="20" fill="#fffdf7"/><rect x="180" y="100" width="15" height="560" fill="#a6553e"/><text x="250" y="220" font-family="sans-serif" font-size="22" fill="#a6553e">PRODUCT / REQUIREMENTS</text><text x="245" y="355" font-family="serif" font-size="100" fill="#253b46">From intent</text><text x="245" y="465" font-family="serif" font-size="100" fill="#253b46">to a clear plan.</text><path d="M250 540h420M250 563h300" stroke="#bec2bd" stroke-width="5"/></svg>',
        ),
      )
        .webp()
        .toBuffer();
      manifest.files.push("artwork/prd.webp");
      manifest.skills[0].cover = {
        path: "artwork/prd.webp",
        alt: { en: "An editorial cover for the PRD writing skill", "zh-CN": "PRD 写作技能的编辑风格封面" },
      };
      manifest.skills[0].readme = {
        en: "Start with the product brief. Clarify open decisions. Produce an evidence-aware PRD with testable acceptance criteria.",
        "zh-CN": "从产品目标开始，明确待定决策，整理需求与可操作的验收条件。",
      };
      const resources = initial.pack.resources.map((file) => ({
        path: file.path,
        bytes: initial.pack.read(file.path),
      }));
      resources.push({ path: "artwork/prd.webp", bytes: artwork });
      const pack = await verifySkillResources(new TextEncoder().encode(JSON.stringify(manifest)), resources);
      const content = new TextDecoder().decode(encodeSkillBundle(pack));
      assert.deepEqual(
        (await decodeSkillBundle(new TextEncoder().encode(content))).manifest.skills[0].cover,
        manifest.skills[0].cover,
      );
      const invalidManifest = structuredClone(manifest);
      invalidManifest.version = "1.0.1";
      const invalidResources = resources.map((resource) =>
        resource.path === "artwork/prd.webp"
          ? { path: resource.path, bytes: new TextEncoder().encode("<!doctype html><h1>Not raster data</h1>") }
          : resource,
      );
      const invalidPack = await verifySkillResources(
        new TextEncoder().encode(JSON.stringify(invalidManifest)),
        invalidResources,
      );
      const invalidReview = await context.request.post(fixture.base + "/api/skill-packs/review", {
        headers: { Origin: fixture.base },
        data: {
          content: new TextDecoder().decode(encodeSkillBundle(invalidPack)),
          name: "invalid-cover.skill.json",
          selected: ["writing"],
        },
      });
      assert.equal(invalidReview.status(), 400);
      assert.equal((await invalidReview.json()).code, "invalidInput");
      const review = await api("/api/skill-packs/review", {
        content,
        name: "covers.skill.json",
        selected: manifest.skills.map((skill) => skill.id),
      });
      await api("/api/skill-packs/install", {
        content,
        name: "covers.skill.json",
        approval: {
          id: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
          capabilities: review.capabilities,
        },
      });
      const catalog = await api("/api/template-catalog?limit=100");
      const entry = catalog.templates.find(
        (item) => item.reference.packageId === manifest.id && item.reference.exportId === "writing",
      );
      assert.equal(entry.label.labels.fr.description, "Description traduite sans nom traduit.");
      const query = new URLSearchParams({
        id: manifest.id,
        version: manifest.version,
        digest: pack.digest,
        exportId: "writing",
      });
      const url = fixture.base + "/api/skill-packs/cover?" + query;
      const response = await context.request.get(url);
      assert.equal(response.status(), 200);
      assert.match(response.headers()["content-type"], /image\/webp/);
      assert.equal(response.headers()["cache-control"], "private, max-age=3600, immutable");
      assert.match(response.headers()["server-timing"], /cover-read;dur=[0-9.]+, cover-render;dur=[0-9.]+/);
      assert.equal((await sharp(await response.body()).metadata()).width, 960);
      assert.equal(
        (await context.request.get(url, { headers: { "if-none-match": response.headers().etag } })).status(),
        304,
      );
      const cachePage = await context.newPage();
      await cachePage.goto(fixture.base + "/api/auth/status");
      const cachedLoads = await cachePage.evaluate(async (url) => {
        const loads = [];
        for (let i = 0; i < 2; i++) {
          performance.clearResourceTimings();
          const image = new Image();
          image.src = url;
          document.body.append(image);
          await image.decode();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          loads.push(
            performance.getEntriesByName(url).map((entry) => ({
              transferSize: entry.transferSize,
              duration: entry.duration,
            })),
          );
          image.remove();
        }
        return loads;
      }, url);
      assert.ok(cachedLoads[0].length >= 1);
      // Memory-cache reuse may omit a duplicate resource entry entirely.
      assert.ok(
        cachedLoads[1].every((entry) => entry.transferSize === 0),
        "Reopening a cover should use the private browser cache",
      );
      await writeFile(
        `.artifacts/skill-covers/cache-${width}.json`,
        JSON.stringify({ first: cachedLoads[0], repeat: cachedLoads[1], headers: response.headers() }, null, 2),
      );
      await cachePage.close();
      const stranger = await browser.newContext();
      assert.equal((await stranger.request.get(url, { maxRedirects: 0 })).status(), 401);
      await stranger.close();
      query.set("digest", "f".repeat(64));
      assert.equal((await context.request.get(fixture.base + "/api/skill-packs/cover?" + query)).status(), 409);
      const portable = await portableFixture();
      const portableId = "example.article-outline",
        indexEntry = portable.index.entries.find((entry) => entry.id === portableId);
      const portablePath =
        indexEntry.manifest.slice(0, indexEntry.manifest.lastIndexOf("/") + 1) + "artwork/cover.webp";
      portable.files.push({ path: portablePath, encoding: "base64", data: artwork.toString("base64") });
      await editPortableFixture(portable, portableId, (manifest) => {
        manifest.previews = ["artwork/cover.webp"];
        manifest.files.push({
          path: "artwork/cover.webp",
          sha256: createHash("sha256").update(artwork).digest("hex"),
          bytes: artwork.length,
          mediaType: "image/webp",
        });
        manifest.id += "-" + width;
      });
      const portableContent = JSON.stringify(portable);
      const portableReview = await api("/api/templates/review", {
        content: portableContent,
        name: "portable-covers.json",
        selected: [portableId + "-" + width + "@1.0.0"],
      });
      const portableInstalled = await api("/api/templates/install", {
        content: portableContent,
        name: "portable-covers.json",
        approval: {
          operationId: randomUUID(),
          expectedRevision: portableReview.revision,
          reviewHash: portableReview.reviewHash,
          selected: portableReview.selected,
        },
      });
      const portableItem = portableInstalled.current.templates.find((entry) => entry.id === portableId + "-" + width);
      const portableQuery = new URLSearchParams({
        id: portableItem.id,
        version: portableItem.version,
        digest: portableItem.digest,
      });
      const portableResponse = await context.request.get(fixture.base + "/api/templates/cover?" + portableQuery);
      assert.equal(portableResponse.status(), 200);
      assert.equal((await sharp(await portableResponse.body()).metadata()).height, 600);
      portableQuery.set("path", "instructions.md");
      assert.equal((await context.request.get(fixture.base + "/api/templates/cover?" + portableQuery)).status(), 400);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
      await page.goto(fixture.base + "/skills/writing");
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      const center = page.locator(".template-manager");
      await center.locator("[data-template-search]").fill(manifest.id);
      const card = center.locator(`[data-template-key="${entry.key}"]`);
      await card.waitFor();
      await page.waitForFunction(() => document.querySelectorAll(".template-manager .template-card").length === 1);
      await page.waitForFunction((key) => {
        const image = [...document.querySelectorAll("[data-template-key]")]
          .find((node) => node.dataset.templateKey === key)
          ?.querySelector("img");
        return image?.complete && image.naturalWidth > 0;
      }, entry.key);
      await page.screenshot({ path: `.artifacts/skill-covers/writing-${width}.png` });
      const bounds = await card.locator(".template-cover").boundingBox();
      assert.ok(Math.abs(bounds.width / bounds.height - 16 / 9) < 0.02);
      await card.click();
      const detail = page.locator("#managedTemplateDialog");
      await detail.locator('[data-template-detail="preview"]:enabled').waitFor();
      assert.match(
        await detail.locator(".template-introduction").textContent(),
        locale === "en" ? /product brief/ : /产品目标/,
      );
      assert.match(
        await detail.locator(".template-detail-cover img").getAttribute("alt"),
        locale === "en" ? /editorial cover/ : /编辑风格封面/,
      );
      await page.screenshot({ path: `.artifacts/skill-covers/detail-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await detail.locator('[data-template-detail="close"]').click();
      // A failed thumbnail retains its allocated geometry and the designed local fallback.
      await page.route("**/api/skill-packs/cover?**", (route) => route.abort());
      await page.reload();
      await center.locator("[data-template-search]").fill(manifest.id);
      await card.locator(".skill-artwork").waitFor({ state: "attached" });
      assert.equal(await card.locator(".template-cover img").count(), 0);
      assert.equal(await card.locator("svg").isVisible(), true);
      const fallbackBounds = await card.locator(".template-cover").boundingBox();
      assert.ok(Math.abs(fallbackBounds.height - bounds.height) < 1);
      await page.screenshot({ path: `.artifacts/skill-covers/fallback-${width}.png` });
      for (const section of ["research", "slides", "image", "web", "video"]) {
        await page.goto(fixture.base + "/skills/" + section);
        await center.locator("[data-template-search]").fill(manifest.id);
        await page.waitForFunction(() => document.querySelectorAll(".template-manager .template-card").length === 1);
        const categoryCard = center.locator(".template-card");
        await categoryCard.locator(".skill-artwork").waitFor({ state: "attached" });
        assert.equal(await categoryCard.count(), 1);
        assert.equal(await categoryCard.locator(".template-cover > svg,.template-cover > img").count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: `.artifacts/skill-covers/${section}-${width}.png` });
      }
      assert.deepEqual(errors, []);
      console.log(
        `${engine.name()} ${width}: localized skill artwork, authenticated derivatives, independent description translations and stable failure fallback verified`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.dispose();
}
