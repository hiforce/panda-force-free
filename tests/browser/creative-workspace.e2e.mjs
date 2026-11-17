import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { nativeSkillPackage } from "../support/native-skill-package.js";
import { chromium, webkit } from "playwright";
import { mkdir } from "node:fs/promises";
import { createAppFixture } from "../support/app-fixture.mjs";
const fixture = await createAppFixture({
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
});
await mkdir(".artifacts/workspace-layout/creative", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const b = await engine.launch();
    try {
      const c = await b.newContext({ viewport: { width, height: 960 }, locale });
      await fixture.signIn(c);
      const api = async (path, data) => {
        const r =
          data === undefined
            ? await c.request.get(fixture.base + path)
            : await c.request.post(fixture.base + path, { data, headers: { Origin: fixture.base } });
        assert.ok(r.ok(), await r.text());
        return r.json();
      };
      const state = await api("/api/projects");
      const created = await api("/api/projects", {
        name: "Review " + width,
        code: "visual-" + width,
        revision: state.revision,
      });
      const project = created.projects.find((p) => p.code === "visual-" + width);
      const pack = await nativeSkillPackage("review.writing-" + width);
      const review = await api("/api/skill-packs/review", {
        content: pack.content,
        name: "writing.skill.json",
        selected: ["blog-outline", "brand-voice"],
      });
      await api("/api/skill-packs/install", {
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
      await api("/api/publication-accounts", {
        id: randomUUID(),
        projectId: project.id,
        name: "Writing account " + width,
        provider: "x",
        application: { clientId: "fixture-client", callbackUrl: fixture.base + "/api/publication-accounts/x/callback" },
      });
      const p = await c.newPage(),
        errors = [];
      p.on("pageerror", (e) => {
        errors.push(e.message);
        console.log("page error", e.message);
      });
      p.on("response", async (r) => {
        if (r.url().includes("/api/personal") && r.status() >= 400)
          console.log("personal request failed", r.status(), r.url(), await r.text());
      });
      const snap = async (name) => {
        await p.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
        });
        await p.screenshot({ path: ".artifacts/workspace-layout/creative/" + name + "-" + width + ".png" });
        if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error("Overflow " + name);
      };
      await p.goto(fixture.base + "/create?view=works");
      await p
        .locator("[data-creative-status]")
        .filter({ hasText: /Loading|加载/ })
        .waitFor({ state: "hidden" })
        .catch(() => {});
      await snap("create");
      await p.locator("[data-creative-new]").click();
      await p
        .locator("#documentTitle")
        .waitFor({ timeout: 15000 })
        .catch(async (e) => {
          console.log("after create", p.url(), await p.locator("body").innerText());
          throw e;
        });
      await snap("editor");
      await p.goto(fixture.base + "/create?view=works");
      await p.locator(".creative-card").first().waitFor();
      await snap("create-saved");
      assert.equal(await p.locator("[data-creative-more]").isVisible(), false);
      await p.locator("[data-creative-copy]").first().click();
      await p.locator(`#creativeActionDialog input[name="project-${project.id}"]`).check();
      await p.locator("#creativeActionDialog [type=submit]").click();
      await p.locator("#creativeActionDialog").waitFor({ state: "hidden" });
      await p.goto(fixture.base + "/project?id=" + project.id);
      await p.locator(".creative-card").first().waitFor();
      await p.locator("[data-creative-heading]").filter({ hasText: project.name }).waitFor();
      await snap("project");
      await p.goto(fixture.base + "/create");
      await p.locator("#prompt").fill("A draft that survives skill selection.");
      await p.goto(fixture.base + "/skills/writing");
      await p
        .locator("[data-template-action=detail]")
        .filter({ hasText: locale === "en" ? "Blog outline" : "博客结构" })
        .first()
        .click();
      await p.locator("[data-template-detail=apply]:visible").click();
      await p.locator(".creation-entry-composer #composer").waitFor();
      assert.equal(await p.locator("#prompt").inputValue(), "A draft that survives skill selection.");
      assert.ok(
        await p
          .locator("#composerSkills")
          .innerText()
          .then((t) => t.includes(locale === "en" ? "Blog outline" : "博客结构")),
      );
      await p.locator("[data-creative-remove-skill]").last().click();
      await p.locator("#sendButton").click();
      await p.locator(".creation-task .user-input-card").first().waitFor();
      await p.locator(".creation-task .user-input-option").first().click();
      await p.locator(".creation-task .user-input-submit").first().click();
      await p.locator("[data-creation-open]:visible").waitFor();
      await snap("creation-task");
      await p.goto(fixture.base + "/skills/writing");
      await p.locator(".template-card").first().waitFor();
      await snap("skills");
      await p.goto(fixture.base + "/publish");
      await p.locator(".publish-channel").first().waitFor();
      await snap("publish");
      await p.locator('[data-publish-channel="x"]').click();
      await p.locator('[data-publish-format="x-article"]').click();
      await p.locator("[data-template-grid]").waitFor();
      await snap("channel");
      await p.goto(fixture.base + "/publish/x?project=" + project.id);
      await p.locator('[data-publish-format="x-article"]').click();
      assert.equal(new URL(p.url()).searchParams.get("project"), project.id);
      await p
        .locator(".publish-object")
        .filter({ hasText: "Writing account " + width })
        .waitFor();
      await p.locator("[data-publish-object]").first().click();
      await p.locator("#socialAccountForm").waitFor();
      await snap("object");
      await p.goto(fixture.base + "/settings/appearance");
      await p.locator("#settingsDialog[open]").waitFor();
      await snap("settings");
      await p.goto(fixture.base + "/settings/templates");
      await p.waitForURL("**/skills/writing");
      await p.locator(".skills-workspace").waitFor();
      assert.equal(await p.locator("[data-skills-select]").inputValue(), "writing");
      if (width === 390) {
        await p.setViewportSize({ width: 320, height: 900 });
        for (const route of ["/create", "/skills/writing", "/publish/x"]) {
          await p.goto(fixture.base + route);
          await p.locator(route === "/create" ? ".creation-entry-composer #composer" : "#workbenchContent").waitFor();
          assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
      }
      if (errors.length) throw Error(errors.join("\n"));
      console.log(locale, width, "completed");
    } finally {
      await b.close();
    }
  }
} finally {
  await fixture.dispose();
}
