import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../../tests/support/app-fixture.mjs";

// Capture the real application with disposable demo content and a simulated engine.
// Run after build:client; no production accounts, provider calls or live workspace are used.
const output = resolve(process.env.PANDA_FORCE_README_SCREENSHOTS || "panda-docs/static/img"),
  records = [];
await mkdir(output, { recursive: true });
for (const locale of ["en", "zh-CN"]) {
  const zh = locale === "zh-CN",
    app = await createAppFixture({
      account: { type: "apiKey" },
      sessionPresentation: {
        titles: zh
          ? ["整理项目资料", "起草发布说明", "规划下一步工作"]
          : ["Organize project references", "Draft release notes", "Plan the next steps"],
        timestamp: Math.floor(Date.now() / 1000),
      },
    }),
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  let mobileBrowser;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale }),
      theme = zh ? "aurora" : "silk";
    await context.addInitScript(
      ({ locale, theme }) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
        }
      },
      { locale, theme },
    );
    await app.signIn(context);
    const api = async (path, body) => {
      const response =
        body === undefined
          ? await context.request.get(app.base + path, { headers: { Origin: app.base } })
          : await context.request.post(app.base + path, { data: body, headers: { Origin: app.base } });
      assert.ok(response.ok(), `Demo preparation failed: ${path} (${response.status()}): ${await response.text()}`);
      return response.json();
    };
    let catalog = await api("/api/projects");
    catalog = await api("/api/projects", {
      code: "product-handbook",
      name: zh ? "产品手册" : "Product handbook",
      revision: catalog.revision,
    });
    const project = catalog.projects.find((item) => item.code === "product-handbook"),
      page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
    const ready = async (target) => {
      await target.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await target.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
      });
    };
    const capture = async (target, name) => {
      await ready(target);
      assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const file = `${name}-${locale}.webp`;
      await sharp(await target.screenshot())
        .webp({ quality: 84 })
        .toFile(resolve(output, file));
      records.push({ file, viewport: target.viewportSize(), locale, theme, demoContent: true });
    };
    await page.goto(app.base + "/workspace");
    await page.locator("#gadgetDocumentPrompt").waitFor();
    await page.locator("[data-gw=customize]:enabled").waitFor();
    await page
      .locator("#gadgetDocumentPrompt")
      .fill(
        zh
          ? "把项目资料整理成一份清晰的产品手册。先给出结构，保留来源事实，标出需要我确认的内容。"
          : "Turn these project notes into a clear product handbook. Start with an outline, keep the source facts intact, and flag anything that needs review.",
      );
    await capture(page, "workspace");
    await page.goto(app.base + "/documents?project=" + project.id);
    await ready(page);
    const documents = zh
      ? [
          [
            "项目概览",
            "<h2>从想法到可交付内容</h2><p>在同一个项目中组织讨论、资料和文档，让每次修改都有清晰的上下文。</p>",
          ],
          [
            "写作规范",
            "<h2>让内容更易读</h2><p>使用简短标题、明确的小节和可核验的来源。先审阅建议，再应用到原稿。</p>",
          ],
          [
            "产品入门指南",
            "<h2>让好想法成为可复用的成果</h2><p>把会话、资料和团队积累放进项目，从一份清晰的文档开始推进工作。</p><h2>一套直接的工作流程</h2><ol><li>创建项目，收集相关文件与来源。</li><li>选择适合的技能，起草并逐项审阅内容。</li><li>完善文档，保存版本，准备发布。</li></ol><h2>保留上下文，减少重复</h2><p>文档树组织结构，自动保存记录进展。把常用的方法整理成技能，让下一次创作更顺畅。</p><blockquote><p>先把事情说清楚，再让工具帮助你推进。</p></blockquote>",
          ],
        ]
      : [
          [
            "Project overview",
            "<h2>From an idea to useful work</h2><p>Keep conversations, references and documents in one project so each change has clear context.</p>",
          ],
          [
            "Writing principles",
            "<h2>Make content easier to read</h2><p>Use short headings, clear sections and traceable sources. Review suggestions before applying them to an original.</p>",
          ],
          [
            "Getting started with your project",
            "<h2>Turn good ideas into reusable work</h2><p>Bring conversations, references and shared knowledge into a project. Start with one clear document and build from there.</p><h2>A straightforward workflow</h2><ol><li>Create a project and gather the relevant files and sources.</li><li>Choose useful skills, draft content and review each suggestion.</li><li>Refine the document, save a version and prepare to publish.</li></ol><h2>Keep context. Reduce repetition.</h2><p>A document tree keeps the structure clear while autosave preserves progress. Turn repeatable methods into skills for your next piece of work.</p><blockquote><p>Make the work clear, then let your tools help move it forward.</p></blockquote>",
          ],
        ];
    for (const [title, content] of documents) {
      console.log(`${locale}: preparing document ${title}`);
      const previousDocument = new URL(page.url()).searchParams.get("document");
      const [previousTitle] = await page.locator("#documentTitle").elementHandles();
      await page.locator('[data-authoring-action="new"]:visible').first().click();
      await page.waitForURL(
        (url) => !!url.searchParams.get("document") && url.searchParams.get("document") !== previousDocument,
      );
      if (previousTitle) await page.waitForFunction((element) => !element.isConnected, previousTitle);
      const surface = page.locator('.document-rich-content[contenteditable="true"]');
      await surface.waitFor();
      await page.locator("#documentTitle").fill(title);
      await surface.evaluate((element, html) => {
        const clipboard = new DataTransfer();
        clipboard.setData("text/html", html);
        clipboard.setData("text/plain", html.replace(/<[^>]*>/g, " "));
        element.focus();
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
        );
      }, content);
      await page
        .waitForFunction(() =>
          /Draft saved|All changes saved|草稿已保存|所有修改已保存/.test(
            document.querySelector("#documentSaveState")?.textContent || "",
          ),
        )
        .catch(async (error) => {
          console.error("Demo save state", await page.locator("#documentSaveState").innerText());
          await page.screenshot({ path: `.artifacts/readme-capture-failure-${locale}.png` });
          throw error;
        });
      const more = page.locator(".document-editor-more");
      await more.locator("summary").click();
      await more.locator('[data-doc-action="save"]:enabled').click();
      await page.waitForFunction(() =>
        /^(Version saved|版本已保存)$/.test(document.querySelector("#documentSaveState")?.textContent || ""),
      );
      await page.locator("[data-tree-id]").filter({ hasText: title }).first().waitFor();
      if ((await more.getAttribute("open")) !== null) await more.locator("summary").click();
    }
    await page.locator("#documentTitle").focus();
    await capture(page, "documents");
    const documentUrl = page.url();
    await page.goto(app.base + "/skills/writing");
    await page.locator('[data-template-action="detail"]').first().waitFor();
    await capture(page, "skills");
    mobileBrowser = await webkit.launch({ headless: true });
    const mobile = await mobileBrowser.newContext({
      viewport: { width: 390, height: 844 },
      locale,
      isMobile: true,
      hasTouch: true,
    });
    await mobile.addInitScript(
      ({ locale, theme }) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
        }
      },
      { locale, theme },
    );
    await app.signIn(mobile);
    const mobilePage = await mobile.newPage();
    mobilePage.on("pageerror", (error) => errors.push(error.message));
    await mobilePage.goto(documentUrl);
    await mobilePage.locator('.document-rich-content[contenteditable="false"]').waitFor();
    await capture(mobilePage, "mobile");
    assert.deepEqual(errors, []);
    await mobile.close();
    await context.close();
  } finally {
    await mobileBrowser?.close();
    await browser.close();
    await app.dispose();
  }
}
await writeFile(
  resolve(output, "readme-captures.json"),
  JSON.stringify({ simulatedEngine: true, productionData: false, captures: records }, null, 2) + "\n",
);
console.log(`Captured ${records.length} current-interface screenshots with disposable demonstration data.`);
