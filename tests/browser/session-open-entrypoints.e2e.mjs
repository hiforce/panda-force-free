import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const records = [];
const out = process.env.PANDA_SESSION_SCREENSHOTS || ".artifacts/session-open-entrypoints";
await mkdir(out, { recursive: true });
for (const [engine, width, locale] of [
  [chromium, 1440, "en"],
  [webkit, 390, "zh-CN"],
  [webkit, 390, "zh-HK"],
  [webkit, 320, "zh-TW"],
]) {
  const app = await createAppFixture({
    prepareState: async ({ dir }) => {
      const path = dir + "/codex",
        source = await readFile(path, "utf8");
      const match = source.match(/const threads=(.*);\nconst queues/);
      const threads = JSON.parse(match[1]);
      for (const thread of threads) {
        thread.updatedAt = Date.now() / 1000;
        if (thread.id === "old-beta") thread.status = { type: "active", activeFlags: ["waitingForApproval"] };
        thread.turns = [
          {
            id: "turn-" + thread.id,
            status: "completed",
            items: [{ id: "answer-" + thread.id, type: "agentMessage", text: "Ready " + thread.id }],
          },
        ];
      }
      await writeFile(path, source.replace(match[0], "const threads=" + JSON.stringify(threads) + ";\nconst queues"));
    },
  });
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      locale,
      isMobile: width < 768,
      hasTouch: width < 768,
    });
    await app.signIn(context);
    await context.addInitScript(
      ({ locale }) => {
        if (/^https?:$/.test(location.protocol)) {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", "aurora");
        }
      },
      { locale },
    );
    const snapshot = await (await context.request.get(app.base + "/api/projects")).json();
    const created = await (
      await context.request.post(app.base + "/api/projects", {
        headers: { Origin: app.base },
        data: { name: "Entry project", code: "entry", revision: snapshot.revision },
      })
    ).json();
    const project = created.projects.find((p) => p.code === "entry");
    assert(project);
    assert(
      (
        await context.request.post(app.base + "/api/projects/assign", {
          headers: { Origin: app.base },
          data: { projectId: project.id, sessionIds: ["old-alpha"], revision: created.revision },
        })
      ).ok(),
    );
    const layout = await (await context.request.get(app.base + "/api/gadgets/layout")).json();
    layout.items.push({
      id: "system.attention",
      gadget: "system.attention",
      configVersion: 1,
      config: { limit: 2 },
      title: "",
      x: 8,
      y: 40,
      w: 4,
      h: 6,
      visible: { desktop: true, mobile: true },
    });
    layout.mobileOrder.push("system.attention");
    const saved = await context.request.put(app.base + "/api/gadgets/layout", {
      headers: { Origin: app.base, "If-Match": `"${layout.revision}"` },
      data: { operationId: crypto.randomUUID(), layout },
    });
    assert(saved.ok(), await saved.text());
    let navigationActions = 0;
    await context.route("**/api/gadgets/actions", (route) => {
      navigationActions++;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable" } }),
      });
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    const opened = async (id) => {
      await page.waitForURL("**/task/" + id);
      await page
        .locator("#conversation .message-text")
        .filter({ hasText: "Ready " + id })
        .waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    };
    const menu = async () => {
      const bottom = page.locator('.workbench-mobile-nav [data-route="tasks"]');
      if (width < 768 && (await bottom.isVisible())) return bottom.click();
      if (width < 768) await page.locator("#workspaceNavigationToggle").click();
      await page.locator('.workbench-navigation [data-route="tasks"]').click();
    };
    await page.goto(app.base + "/workspace");
    const recent = page.locator('[data-gadget-type-id="system.recent"] .gadget-row[data-id="old-alpha"]');
    await recent.waitFor();
    const start = performance.now();
    await recent.click();
    await opened("old-alpha");
    const recentMs = performance.now() - start;
    assert.equal(navigationActions, 0, "Session navigation must not wait for the gadget action service");
    await page.locator("#prompt").fill("Preserve the session draft " + locale);
    await menu();
    await page.locator('[data-wb="task"][data-id="old-beta"]').click();
    await opened("old-beta");
    await menu();
    await page.locator('[data-wb="task"][data-id="old-alpha"]').click();
    await opened("old-alpha");
    assert.equal(await page.locator("#prompt").inputValue(), "Preserve the session draft " + locale);
    await page.keyboard.press("Control+k");
    await page.locator("#wbCommandQuery").fill("Old beta");
    await page.locator('#wbCommandResults [data-wb="task"][data-id="old-beta"]').click();
    await opened("old-beta");
    assert.equal(await page.locator("#workbenchDialog").isVisible(), false);
    await page.goto(app.base + "/project?id=" + project.id + "&tab=sessions");
    await page.locator('[data-wb="task"][data-id="old-alpha"]').click();
    await opened("old-alpha");
    assert.equal(await page.locator("#prompt").inputValue(), "Preserve the session draft " + locale);
    if (width < 768) await page.locator("#workspaceNavigationToggle").click();
    await page.locator("#sidebarSessionsTab").click();
    const unassigned = page.locator('[data-project="__tasks__"]');
    const expand = unassigned.locator(".sidebar-project-row").first();
    if ((await expand.getAttribute("aria-expanded")) === "false") await expand.click();
    await unassigned.locator('.thread-item[data-id="old-beta"]').click();
    await opened("old-beta");
    await page.goto(app.base + "/task/old-alpha");
    await opened("old-alpha");
    await page.goto(app.base + "/workspace");
    await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
    const attention = page.locator('[data-gadget-type-id="system.attention"] .gadget-row[data-id="old-beta"]');
    await attention.waitFor();
    await attention.click();
    await opened("old-beta");
    await page.goBack();
    await page.locator("#gadgetDocumentPrompt:enabled").waitFor();
    await page.goForward();
    await opened("old-beta");
    await page.goto(app.base + "/create");
    await page.locator("#prompt:enabled").waitFor();
    await page.locator("#prompt").fill("Keep creation draft " + locale);
    await page.keyboard.press("Control+k");
    await page.locator("#wbCommandQuery").fill("Old alpha");
    await page.locator('#wbCommandResults [data-wb="task"][data-id="old-alpha"]').click();
    await opened("old-alpha");
    await page.goto(app.base + "/create");
    await page.locator("#prompt:enabled").waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), "Keep creation draft " + locale);
    await page.goto(app.base + "/task/old-alpha");
    await opened("old-alpha");
    assert.equal(navigationActions, 0);
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: out + `/session-${width}-${locale}.png`, animations: "disabled" });
    records.push({
      engine: engine.name(),
      width,
      locale,
      recentMs,
      navigationActions,
      menu: true,
      project: true,
      search: true,
      sidebar: true,
      attention: true,
      browserBackForward: true,
      directUrl: true,
      draftPreserved: true,
      creationDraftPreserved: true,
      errors: 0,
    });
    await context.close();
  } finally {
    await browser.close();
    await app.dispose();
  }
}
await writeFile(out + "/verification.json", JSON.stringify({ passed: true, records }, null, 2));
console.log(
  "Session entrypoints use the common opener across desktop and mobile; gadget service failure cannot block navigation",
);
