import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createBrowserFixture, launchOptions } from "../support/browser-runtime.mjs";
import { waitFor } from "../support/app-fixture.mjs";
import { createConversationHistory } from "../../src/server/conversation/history.js";

const fixture = await createBrowserFixture();
const browser = await fixture.launchBrowser(launchOptions());
const directory = ".artifacts/session-workspace-implementation";
await mkdir(directory, { recursive: true });
const checks = [],
  errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: "en",
    colorScheme: "light",
  });
  await context.addInitScript(() => {
    if (window === window.top) localStorage.setItem("panda-force-theme", "light");
  });
  const projects = [];
  for (const [name, code] of [
    ["Atlas shop", "atlas"],
    ["Orbit studio", "orbit"],
  ]) {
    const { revision } = await (await context.request.get(fixture.base + "/api/projects")).json();
    const response = await context.request.post(fixture.base + "/api/projects", {
      headers: { origin: fixture.base },
      data: { name, code, revision },
    });
    assert.equal(response.ok(), true, await response.text());
    projects.push((await response.json()).projects.find((project) => project.code === code));
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const go = async (id) => {
    await page.goto(fixture.base + "/task/" + id);
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.waitForFunction(
      (id) =>
        globalThis.__pandaForceDebug?.state.active?.id === id && globalThis.__pandaForceDebug.state.models.length > 0,
      id,
    );
  };
  const switchTo = async (id) => {
    await page.evaluate((id) => globalThis.__pandaForceDebug.openThread(id), id);
    await page.waitForFunction((id) => globalThis.__pandaForceDebug.state.active?.id === id, id);
  };
  const openInspector = async () => {
    if (!(await page.locator("#sessionInspector").isVisible())) await page.locator("#sessionInfoButton").click();
  };
  const closeDialog = async (id) => {
    await page.locator(`${id} [data-session-dismiss], ${id} [data-settings-dismiss]`).first().click();
    await page.locator(id).waitFor({ state: "hidden" });
  };
  const usage = {
    total: { totalTokens: 124800, inputTokens: 96000, outputTokens: 28800, cachedInputTokens: 64000 },
    last: { totalTokens: 76200 },
    modelContextWindow: 200000,
  };
  const reportUsage = async () =>
    page.evaluate(
      (usage) =>
        globalThis.__pandaForceDebug.notify("thread/tokenUsage/updated", { threadId: "old-alpha", tokenUsage: usage }),
      usage,
    );
  await go("old-alpha");
  await page.waitForFunction(
    () =>
      !document
        .querySelector("#app")
        .getAnimations()
        .some((animation) => animation.playState === "running"),
  );
  const geometry = await page.evaluate(() => {
    const shell = document.querySelector(".conversation-shell").getBoundingClientRect();
    const inspector = document.querySelector("#sessionInspector").getBoundingClientRect();
    return {
      shellRight: shell.right,
      inspectorLeft: inspector.left,
      inspectorRight: inspector.right,
      modal: document.querySelector("#sessionInspector").matches(":modal"),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(geometry.modal, false);
  assert.equal(geometry.overflow, false);
  assert.ok(Math.abs(geometry.shellRight - geometry.inspectorLeft) < 2, JSON.stringify(geometry));
  assert.ok(geometry.inspectorRight <= 1441, JSON.stringify(geometry));
  assert.equal(await page.locator("#businessProjectContext").isVisible(), false);
  assert.equal(await page.locator("#sessionStatus").isVisible(), false);
  assert.equal(await page.locator("#composer #modelButton").count(), 0);
  assert.equal(await page.locator("#sessionConfiguration #modelButton").isVisible(), true);
  assert.equal(await page.locator("#sessionPendingAction").isVisible(), false);
  assert.match(await page.locator("#sessionUsageView").innerText(), /Not reported by the engine/);
  await reportUsage();
  const tokens = await page.locator("#sessionUsageView").innerText();
  for (const value of ["124.8K", "96K", "28.8K", "64K", "38%", "76.2K", "200K"])
    assert.ok(tokens.includes(value), tokens);
  assert.equal(await page.locator("#sessionUsageView [role=meter]").getAttribute("aria-valuenow"), "38.1");
  checks.push(
    "Desktop three-column layout, canonical controls, no duplicate status, real session tokens and context occupancy",
  );

  await page.locator("#prompt").fill("Keep this draft and caret");
  await page.locator("#prompt").evaluate((input) => {
    input.focus();
    input.setSelectionRange(5, 9);
  });
  await reportUsage();
  assert.equal(
    await page
      .locator("#prompt")
      .evaluate((input) => document.activeElement === input && input.selectionStart === 5 && input.selectionEnd === 9),
    true,
  );
  await page.locator("#modelButton").click();
  await page.locator("#sessionSettingModel").selectOption("gpt-5.6-luna");
  await page.locator('input[name="session-effort"][value="high"]').check();
  await closeDialog("#sessionSettingsDialog");
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "gpt-5.6-sol");
  await page.locator("#modelButton").click();
  await page.locator("#sessionSettingModel").selectOption("gpt-5.6-luna");
  await page.locator('input[name="session-effort"][value="high"]').check();
  await page.locator('#sessionSettingsForm [type="submit"]').click();
  await page.locator("#sessionSettingsDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "gpt-5.6-luna");
  assert.equal(await page.locator("#effortSelect").inputValue(), "high");
  assert.equal(await page.locator("#prompt").inputValue(), "Keep this draft and caret");
  await page.evaluate(() => globalThis.__pandaForceDebug.setPermissionVisibility("fullAccess", true));
  await page.locator("#modeButton").click();
  await page.locator('input[name="session-permission"][value="full-access"]').check();
  await page.locator('#sessionSettingsForm [type="submit"]').click();
  await page.locator("#fullAccessDialog").waitFor({ state: "visible" });
  assert.notEqual(await page.evaluate(() => globalThis.__pandaForceDebug.state.permissionMode), "full-access");
  await page.locator("#fullAccessDialog").evaluate((dialog) => dialog.close());
  await page.locator("#modeButton").click();
  await page.locator('input[name="session-permission"][value="full-access"]').check();
  await page.locator('#sessionSettingsForm [type="submit"]').click();
  await page.locator("#confirmFullAccess").click();
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.permissionMode), "full-access");
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.setPermissionProfiles([
      { id: "managed-review", description: "Managed review policy", allowed: true },
      { id: "managed-blocked", description: "Unavailable policy", allowed: false },
    ]),
  );
  await page.locator("#modeButton").click();
  assert.equal(
    await page.locator('input[name="session-permission"][value="profile:managed-blocked"]').isDisabled(),
    true,
  );
  await page.locator('input[name="session-permission"][value="profile:managed-review"]').check();
  await page.evaluate(() =>
    globalThis.__pandaForceDebug.setPermissionProfiles([
      { id: "managed-review", description: "Policy revoked during editing", allowed: false },
    ]),
  );
  assert.equal(
    await page.locator('input[name="session-permission"][value="profile:managed-review"]').isDisabled(),
    true,
  );
  assert.equal(await page.locator('#sessionSettingsForm button[type="submit"]').isDisabled(), true);
  await closeDialog("#sessionSettingsDialog");
  await page.locator("#modelButton").click();
  await switchTo("old-beta");
  await page.locator("#sessionSettingsDialog").waitFor({ state: "hidden" });
  assert.match(await page.locator("#sessionUsageView").innerText(), /Not reported by the engine/);
  await switchTo("old-alpha");
  checks.push(
    "Model and effort Save/Cancel, retained composer focus and draft, full-access confirmation, stale-dialog closure, isolated usage",
  );

  await page.locator("#sessionAssociateProject").click();
  await page.locator("#associationProjectSearch").fill("orbit");
  assert.equal(await page.locator("#associationProject option").count(), 2);
  await page.locator("#associationProject").selectOption(projects[1].id);
  await page.locator('#projectAssociationForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#sessionProjectName").innerText(), "Orbit studio");
  assert.equal(await page.locator("#sessionProjectCode").innerText(), "orbit");
  assert.equal(await page.locator("#sessionWorkingFolder").innerText(), fixture.alpha);
  checks.push("Searchable project association preserves the session working folder");

  await page.locator("#sessionToolsTab").click();
  await page.locator('[data-session-tool="notes"]').click();
  await page.locator("#sessionNoteInput").fill("Alpha review note");
  await reportUsage();
  assert.equal(await page.locator("#sessionNoteInput").inputValue(), "Alpha review note");
  assert.equal(await page.locator("#sessionNoteInput").evaluate((input) => document.activeElement === input), true);
  await switchTo("old-beta");
  await page.locator('[data-session-tool="notes"]').click();
  assert.equal(await page.locator("#sessionNoteInput").inputValue(), "");
  await switchTo("old-alpha");
  await page.locator('[data-session-tool="notes"]').click();
  assert.equal(await page.locator("#sessionNoteInput").inputValue(), "Alpha review note");
  await page.locator('[data-session-action="back-tools"]').click();
  await page.locator('#sessionToolsView [data-session-action="customize"]').click();
  await page.locator('[data-session-enable="checklist"]').check();
  await page.locator('#sessionToolsDialog [data-session-pin="files"]').click();
  await closeDialog("#sessionToolsDialog");
  await page.locator('[data-session-pin="notes"]').click();
  await page.locator('#sessionToolsView [data-session-action="customize"]').click();
  await page.locator('[data-session-move="notes"][data-direction="-1"]').click();
  await closeDialog("#sessionToolsDialog");
  assert.deepEqual(
    await page
      .locator("#sessionToolShortcuts [data-session-tool]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionTool)),
    ["changes", "notes", "terminal"],
  );
  await page.locator('[data-session-tool="checklist"]').click();
  await page.locator("#sessionChecklistInput").fill("Verify desktop and phone");
  await page.locator('#sessionChecklistForm [type="submit"]').click();
  await page.locator("[data-session-check]").check();
  await page.reload();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.locator("#sessionToolsTab").click();
  await page.locator('[data-session-tool="checklist"]').click();
  assert.equal(await page.locator("[data-session-check]").isChecked(), true);
  await page.locator('[data-session-action="back-tools"]').click();
  await page.locator('[data-session-tool="notes"]').first().click();
  assert.equal(await page.locator("#sessionNoteInput").inputValue(), "Alpha review note");
  checks.push(
    "Local notes/checklist isolate sessions, survive reload, preserve focus; trusted tools can be enabled, pinned and reordered",
  );

  await page.locator("#sessionOverviewTab").click();
  await reportUsage();
  await page.locator("#sessionInfoButton").click();
  await page.locator("#sessionInspector").waitFor({ state: "hidden" });
  await page.evaluate(() => {
    const malicious = document.createElement("button");
    malicious.id = "untrusted-session-action";
    malicious.dataset.sessionAction = "open";
    malicious.dataset.sessionTool = "terminal";
    document.querySelector("#conversation").append(malicious);
    malicious.click();
    malicious.remove();
  });
  assert.equal(await page.locator("#sessionInspector").isVisible(), false);
  assert.equal(await page.locator("#changesPanel").isVisible(), false);
  await openInspector();
  await page.locator("#toggleSidebar").click();
  await page.waitForFunction(() => document.querySelector(".conversation-shell").getBoundingClientRect().x < 2);
  const collapsed = await page.locator(".conversation-shell").boundingBox();
  assert.ok(collapsed.x < 2, JSON.stringify(collapsed));
  await page.locator("#workspaceNavigationToggle").click();
  await page.waitForFunction(() => document.querySelector(".conversation-shell").getBoundingClientRect().x >= 231);
  await page.locator("#sessionActionsButton").click();
  assert.equal(await page.locator("#summarySessionName").isVisible(), true);
  await closeDialog("#sessionActionsDialog");
  await page.screenshot({ path: directory + "/desktop-en.png" });
  checks.push(
    "Inspector collapse/restore, sidebar collapse, session actions, untrusted message attributes cannot invoke tools",
  );

  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [430, 932],
    [740, 390],
    [820, 900],
    [1081, 900],
    [1440, 960],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction((width) => document.querySelector("#sessionInspector").open === width >= 1081, width);
    await page.waitForFunction(
      (height) => Math.abs(document.querySelector("#app").getBoundingClientRect().height - height) < 2,
      height,
    );
    const layout = await page.evaluate(() => {
      const bounds = (id) => {
        const r = document.querySelector(id).getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        composer: bounds("#composer"),
        send: bounds("#sendButton"),
        permission: bounds("#modeButton"),
        model: bounds("#modelButton"),
        nav: getComputedStyle(document.querySelector(".workbench-mobile-nav")).display,
      };
    });
    assert.equal(layout.overflow, false, JSON.stringify({ width, layout }));
    assert.ok(
      layout.send.right <= width && layout.send.bottom <= height + 1 && layout.send.height >= (width < 768 ? 40 : 30),
      JSON.stringify({ width, layout }),
    );
    if (width < 768) {
      assert.equal(layout.nav, "none");
      assert.equal(layout.permission.height, layout.send.height);
      assert.ok(Math.abs(layout.permission.y - layout.send.y) < 1);
      assert.ok(Math.abs(layout.model.y - layout.send.y) < 1);
    }
  }
  checks.push(
    "No overflow at seven desktop/tablet/mobile/landscape sizes; one-row mobile controls and send remain visible",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#modeButton").click();
  assert.equal(await page.locator("#sessionSettingsDialog").evaluate((dialog) => dialog.matches(":modal")), true);
  await page.locator('input[name="session-permission"][value="default"]').check();
  await page.locator('#sessionSettingsForm [type="submit"]').click();
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.permissionMode), "default");
  await page.locator("#modelButton").click();
  await page.screenshot({ path: directory + "/mobile-settings-en.png" });
  await page.keyboard.press("Escape");
  await page.locator("#sessionSettingsDialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#modelButton").evaluate((button) => document.activeElement === button), true);
  await page.locator("#prompt").fill("Mobile draft stays");
  await reportUsage();
  fixture.requestApproval({
    id: "workspace-approval",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "old-alpha",
      turnId: "workspace-turn",
      itemId: "workspace-command",
      command: "echo workspace test",
      cwd: fixture.alpha,
      availableDecisions: ["accept", "decline", "acceptForSession"],
    },
  });
  await page.locator(".approval-card").waitFor();
  await page.waitForFunction(() => document.querySelector("#sessionMobileStatus").textContent === "Approval needed");
  await openInspector();
  assert.equal(await page.locator("#sessionInspector").evaluate((dialog) => dialog.matches(":modal")), true);
  await page.locator("#sessionPendingAction").click();
  await page.locator("#sessionInspector").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".approval-card").evaluate((card) => card.contains(document.activeElement)), true);
  await page.locator(".approval-deny").click();
  await waitFor(() => fixture.calls().find((call) => call.id === "workspace-approval" && call.type === "response"));
  assert.deepEqual(
    fixture.calls().find((call) => call.id === "workspace-approval" && call.type === "response").result,
    { decision: "decline" },
  );
  assert.equal(await page.locator("#prompt").inputValue(), "Mobile draft stays");
  await page.locator('#sessionMobileSummary [data-session-action="usage"]').click();
  assert.ok((await page.locator("#sessionUsageDialogContent").innerText()).includes("124,800"));
  await page.screenshot({ path: directory + "/mobile-usage-en.png" });
  await closeDialog("#sessionUsageDialog");
  checks.push(
    "Native mobile settings, Escape/focus return, approval summary and jump to inline decision, draft retained, usage sheet",
  );

  // Keep the native history fixture consistent with the streamed item during background refreshes.
  const languageItem = { id: "engine-language", type: "agentMessage", text: "Native engine content stays English." };
  let languageHistoryReads = 0;
  const languageHistory = createConversationHistory({
    readThread: async () => ({
      id: "old-alpha",
      name: "Old alpha session",
      cwd: fixture.alpha,
      status: { type: "idle" },
      turns: [{ id: "workspace-turn", status: "completed", items: [languageItem] }],
    }),
    fingerprint: () => "language-fixture",
  });
  await page.route("**/api/rpc", async (route) => {
    const call = route.request().postDataJSON();
    if (call.method === "host/thread/history" && call.params?.threadId === "old-alpha") {
      languageHistoryReads++;
      await route.fulfill({
        json: { type: "rpc/result", id: call.id, result: await languageHistory.read(call.params) },
      });
    } else await route.continue();
  });
  await page.evaluate(() => globalThis.__pandaForceDebug.state.ws?.close());
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.transport === "sse");
  await page.evaluate(() => {
    const api = globalThis.__pandaForceDebug;
    api.notify("item/completed", {
      threadId: "old-alpha",
      turnId: "workspace-turn",
      item: { id: "engine-language", type: "agentMessage", text: "Native engine content stays English." },
    });
  });
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  assert.ok(languageHistoryReads > 0, "The language check must read its authoritative history fixture");
  await page.evaluate(async () => {
    const { getBrowserI18n } = await import("/i18n.js");
    await getBrowserI18n().setPreference("zh-CN");
  });
  await openInspector();
  assert.equal(await page.locator("#sessionInspectorTitle").innerText(), "会话信息");
  assert.match(await page.locator('[data-project="__pinned__"] .sidebar-project-row').textContent(), /已置顶/);
  assert.match(await page.locator("#conversation").innerText(), /Native engine content stays English/);
  await page.screenshot({ path: directory + "/mobile-panel-zh.png" });
  await page.locator('#sessionInspector [data-session-action="close"]').click();
  await page.mouse.move(200, 60);
  await page.screenshot({ path: directory + "/mobile-zh.png" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await openInspector();
  await page.screenshot({ path: directory + "/desktop-zh.png" });
  await page.locator('[data-chrome-menu="appearance"]').click();
  await page.locator('[data-chrome-action="theme"][data-value="dark"]').click();
  await page.screenshot({ path: directory + "/desktop-dark-zh.png" });
  checks.push("Translated UI, unchanged native engine content, light/dark session surfaces");
  for (const [width, height] of [
    [390, 844],
    [820, 900],
    [844, 390],
  ]) {
    const touchContext = await browser.newContext({
      viewport: { width, height },
      screen: { width, height },
      isMobile: true,
      hasTouch: true,
      locale: "en",
    });
    await touchContext.addInitScript(() => {
      if (window !== window.top) return;
      const native = window.visualViewport,
        viewport = new EventTarget();
      for (const name of ["width", "height", "scale", "offsetTop", "offsetLeft"])
        Object.defineProperty(viewport, name, { get: () => viewport["_" + name] ?? native[name] });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      window.__sessionKeyboardViewport = viewport;
    });
    const touchPage = await touchContext.newPage();
    touchPage.on("pageerror", (error) => errors.push(error.message));
    await touchPage.goto(fixture.base + "/task/old-alpha");
    await touchPage.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await touchPage.waitForFunction(
      () => globalThis.__pandaForceDebug?.state.models.length > 0 && document.body.classList.contains("session-layout"),
    );
    assert.equal(await touchPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width >= 768) {
      const visible = await touchPage.locator("#sidebar").evaluate((node) => ({
        opacity: getComputedStyle(node).opacity,
        visibility: getComputedStyle(node).visibility,
        width: node.getBoundingClientRect().width,
      }));
      assert.equal(visible.opacity, "1");
      assert.equal(visible.visibility, "visible");
      assert.ok(visible.width > 200);
    } else {
      await touchPage.locator("#prompt").fill("Keep the mobile keyboard draft");
      await touchPage.evaluate(() => {
        const viewport = window.__sessionKeyboardViewport;
        viewport._height = 420;
        viewport._offsetTop = 18;
        viewport.dispatchEvent(new Event("resize"));
      });
      await touchPage.waitForFunction(
        () => Math.abs(document.querySelector("#app").getBoundingClientRect().height - 420) < 1,
      );
      const send = await touchPage.locator("#sendButton").boundingBox();
      assert.ok(send.y >= 18 && send.y + send.height <= 439);
      await touchPage.locator("#modelButton").tap();
      const sheet = await touchPage.locator("#sessionSettingsDialog").boundingBox();
      assert.ok(sheet.y >= 18 && sheet.y + sheet.height <= 439, JSON.stringify(sheet));
      await touchPage.locator("#sessionSettingModel").selectOption("gpt-5.6-luna");
      await touchPage.locator('input[name="session-effort"][value="high"]').check();
      await touchPage.locator('#sessionSettingsForm button[type="submit"]').tap();
      assert.equal(await touchPage.locator("#prompt").inputValue(), "Keep the mobile keyboard draft");
      assert.equal(await touchPage.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "gpt-5.6-luna");
    }
    await touchContext.close();
  }
  checks.push(
    "Touch phone/tablet/landscape layout, managed-policy changes, keyboard-aware settings and retained draft",
  );
  assert.deepEqual(errors, []);
  await writeFile(directory + "/browser-result.json", JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
} finally {
  await browser.close();
}
