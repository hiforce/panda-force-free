import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const out = ".artifacts/creation-reading";
await mkdir(out, { recursive: true });
const app = await createAppFixture({
  applicationCreation: true,
  models: [
    {
      id: "fixture",
      model: "fixture",
      isDefault: true,
      displayName: "Fixture",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      defaultReasoningEffort: "medium",
    },
  ],
});
const markdown = [
  "PRD 已完成并保存为可编辑文档。",
  "",
  "**保存回执**",
  "",
  "- 文档 ID：11111111-1111-4111-8111-111111111111",
  "- 标题：商品运营管理平台 PRD（v0.1 草案）",
  "",
  "**文档内容概要**",
  "",
  ...Array.from(
    { length: 12 },
    (_, i) =>
      `${i + 1}. **${["问题与证据", "用户与场景", "需求与验收标准"][i % 3]}**：保留原始需求，明确角色、关键场景与可观察的验收方式。`,
  ),
  "",
  "- 资料维护",
  "  - 长内容换行后继续与当前条目的正文对齐，不挤压消息边线。",
  "  - 审核与发布",
  "",
  "```text",
  "- This is code, not a list.",
  "```",
].join("\n");
const records = [];
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 430, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: width < 768 ? 720 : 1000 },
        locale,
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await context.addInitScript((locale) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "light");
        }
      }, locale);
      await app.signIn(context);
      const post = async (path, data) => {
        const r = await context.request.post(app.base + path, { headers: { Origin: app.base }, data });
        assert(r.ok(), await r.text());
        return r.json();
      };
      await post("/api/system/database/selection", { driver: "sqlite" });
      const options = await (await context.request.get(app.base + "/api/personal/document-creations/options")).json();
      const id = crypto.randomUUID(),
        at = Date.now();
      await post("/api/personal/document-creations", {
        id,
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        locale,
        prompt: "编写商品运营平台的需求说明，用中文。",
        profileId: options.defaultProfileId,
        selections: [options.defaultWorkflow],
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(20000);
      let revision = 0,
        progressReads = 0;
      await page.route("**/document-creations/detail?*", async (route) => {
        const r = await route.fetch();
        if (!r.ok()) return route.fulfill({ response: r });
        const data = await r.json();
        const summary = new URL(route.request().url()).searchParams.has("view");
        progressReads++;
        if (summary) {
          data.task.progress = Array.from({ length: 8 }, (_, i) => ({
            stage: i % 2 ? "answered" : "waiting",
            at: at - 8000 + i * 1000,
          }));
        }
        data.task.updatedAt = at + progressReads + revision;
        if (!summary)
          data.task.progress.push({ stage: "message", text: markdown + "\n\n新增的处理进展。".repeat(revision), at });
        await route.fulfill({ response: r, json: data });
      });
      for (const theme of ["light", "dark"]) {
        if (theme === "dark")
          await page.addInitScript(() => {
            if (/^https?:$/.test(location.protocol)) localStorage.setItem("panda-force-theme", "dark");
          });
        await page.goto(app.base + "/creation/" + id + "?creationScope=personal");
        const bubble = page.locator("#conversation .message-text").filter({ has: page.locator("ol") });
        await bubble.locator("ol > li").last().waitFor();
        const g = await bubble.evaluate((node) => {
          const outer = node.getBoundingClientRect(),
            content = node.getBoundingClientRect(),
            ctx = document.createElement("canvas").getContext("2d");
          return {
            outer: { left: outer.left, right: outer.right },
            content: { left: content.left, right: content.right },
            items: [...node.querySelectorAll("li")].map((li) => {
              const r = li.getBoundingClientRect(),
                s = getComputedStyle(li);
              ctx.font = s.font;
              const label =
                li.parentElement.tagName === "OL" ? `${[...li.parentElement.children].indexOf(li) + 1}.` : "•";
              return {
                left: r.left,
                right: r.right,
                markerLeft: r.left - ctx.measureText(label).width - parseFloat(s.fontSize) * 0.5,
              };
            }),
            overflow: node.scrollWidth > node.clientWidth,
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert(g.items.length >= 16);
        assert(!g.overflow && !g.pageOverflow, "Message and page must fit viewport");
        for (const item of g.items) {
          assert(item.markerLeft >= g.content.left - 1, `Marker crosses content edge: ${JSON.stringify({ item, g })}`);
          assert(item.right <= g.outer.right);
        }
        await bubble.screenshot({ path: out + `/after-${width}-${locale}-${theme}.png` });
        if (theme === "light" && width < 768) {
          const root = page.locator("#conversation");
          const max = await root.evaluate((n) => n.scrollHeight - n.clientHeight);
          assert(max > 200, "Use a real overflowing creation page");
          await root.evaluate((n) => (n.scrollTop = n.scrollHeight));
          await page.waitForTimeout(100);
          const bottom = await root.evaluate((n) => n.scrollTop),
            reads = progressReads;
          await page.waitForTimeout(4600);
          const after = await root.evaluate((n) => n.scrollTop);
          console.log({ width, locale, stage: "unchanged", bottom, after, polls: progressReads - reads });
          assert(progressReads - reads >= 2);
          assert(Math.abs(after - bottom) < 2, "Unchanged background polling must retain the bottom scroll position");
          await bubble.locator("ol > li").last().waitFor();
          await root.evaluate((n) => (n.scrollTop = (n.scrollHeight - n.clientHeight) / 2));
          const middle = await root.evaluate((n) => n.scrollTop);
          revision++;
          await page.waitForTimeout(2600);
          const updated = await root.evaluate((n) => n.scrollTop);
          console.log({ width, locale, stage: "changed", middle, updated });
          assert(Math.abs(updated - middle) < 2, "New background messages must retain the reading position");
          await root.evaluate((n) => (n.scrollTop = n.scrollHeight));
          revision++;
          await page.waitForTimeout(2600);
          const tail = await root.evaluate((n) => ({ top: n.scrollTop, max: n.scrollHeight - n.clientHeight }));
          console.log({ width, locale, stage: "new-output-at-bottom", ...tail });
          assert(
            Math.abs(tail.max - tail.top) < 2,
            "New output must retain the reader at the bottom when already following the end",
          );
        }
        records.push({
          engine: engine.name(),
          width,
          locale,
          theme,
          allMarkersInsideContent: true,
          nestedLists: true,
          longReceiptWraps: true,
          noOverflow: true,
          scrollVerified: theme === "light" && width < 768,
        });
      }
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${out}/verification.json`, JSON.stringify({ passed: true, records }, null, 2));
  console.log({ passed: true, cases: records.length });
} finally {
  await app.stop();
}
