import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const fixture = await createAppFixture();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const artifacts = ".artifacts/product-projects";
await mkdir(artifacts, { recursive: true });
const checks = [],
  errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en" });
  await fixture.signIn(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const catalog = async () => (await context.request.get(fixture.base + "/api/projects")).json();
  const go = async (path) => {
    await page.goto(fixture.base + path);
    await page.waitForFunction(() => Boolean(globalThis.__pandaForceDebug?.workbench));
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  };
  const create = async (name, code, description = "") => {
    await page.locator('.workbench-navigation [data-route="projects"]').click();
    await page.locator('[data-wb="create-project"]').first().click();
    await page.locator("#projectNameInput").fill(name);
    await page.locator("#projectCodeInput").fill(code);
    await page.locator("#projectDescriptionInput").fill(description);
    await page.locator('#projectForm [type="submit"]').click();
    await page.locator("#projectDialog").waitFor({ state: "hidden" });
    return (await catalog()).projects.find((p) => p.code === code.toLowerCase());
  };
  await go("/projects");
  assert.equal(await page.locator(".wb-project-main").count(), 0);
  assert.equal((await catalog()).projects.length, 0);
  const a = await create("Product Alpha", "ALPHA", "An explicit product project"),
    b = await create("Product Beta", "beta");
  assert.equal(a.code, "alpha");
  assert.equal("cwd" in a, false);
  checks.push("Explicit project name/code/optional description; existing folders do not create projects");
  await page.locator('[data-wb="project-edit"]').click();
  await page.locator("#projectCodeInput").fill("ALPHA");
  await page.locator('#projectForm [type="submit"]').click();
  await page.locator(".project-error").waitFor({ state: "visible" });
  assert.ok((await page.locator(".project-error").innerText()).includes("already exists"));
  await page.locator("#projectCodeInput").fill("beta");
  await page.locator("#projectDescriptionInput").fill("Updated description");
  await page.locator('#projectForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({ state: "hidden" });
  assert.equal((await catalog()).projects.find((p) => p.id === b.id).description, "Updated description");
  checks.push("Editing and case-insensitive code uniqueness with inline validation");
  await go("/project?id=" + a.id);
  await page.locator('[data-wb="project-link"]').click();
  await page.locator('#associationSessions input[value="old-alpha"]').check();
  await page.locator('#associationSessions input[value="old-beta"]').check();
  await page.locator('#projectAssociationForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({ state: "hidden" });
  let snapshot = await catalog();
  assert.equal(snapshot.assignments.filter((s) => s.projectId === a.id).length, 2);
  assert.deepEqual(snapshot.assignments.map((s) => s.cwd).sort(), [fixture.alpha, fixture.beta].sort());
  assert.equal(await page.locator(`[data-project="project:${a.id}"]`).count(), 1);
  await page.reload();
  await page.locator('.wb-task-row[data-id="old-alpha"]').waitFor();
  assert.equal(await page.locator(".wb-project-detail .project-code").innerText(), "alpha");
  checks.push("Historical sessions from different folders link to one persistent project and sidebar group");
  const changeBeta = () =>
    page.locator('.wb-session-entry:has(.wb-task-row[data-id="old-beta"]) [data-wb="session-project"]');
  await changeBeta().click();
  await page.locator("#associationProject").selectOption(b.id);
  await page.locator('#projectAssociationForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({ state: "hidden" });
  snapshot = await catalog();
  assert.equal(snapshot.assignments.find((s) => s.id === "old-beta").projectId, b.id);
  await go("/tasks");
  await changeBeta().click();
  await page.locator("#associationProject").selectOption("");
  await page.locator('#projectAssociationForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({ state: "hidden" });
  assert.equal(
    (await catalog()).assignments.some((s) => s.id === "old-beta"),
    false,
  );
  checks.push("Move and unlink change only metadata while native session IDs and directories remain intact");
  await go("/project?id=" + a.id);
  await page.locator('[data-wb="project-new"]').first().click();
  await page.locator("#prompt").fill("Draft for Alpha");
  await page.locator("#sessionProjectSelect").selectOption(b.id);
  assert.equal(await page.locator("#prompt").inputValue(), "");
  await page.locator("#prompt").fill("Draft for Beta in the same folder");
  await page.locator("#sessionProjectSelect").selectOption(a.id);
  assert.equal(await page.locator("#prompt").inputValue(), "Draft for Alpha");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "Draft for Alpha");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#sessionProjectSelect").inputValue(), a.id);
  assert.equal(await page.locator(".working-folder-label").innerText(), "Working folder");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.active?.id?.startsWith("new-"));
  const created = await page.evaluate(() => globalThis.__pandaForceDebug.state.active.id);
  await waitFor(async () => (await catalog()).assignments.find((s) => s.id === created));
  assert.equal((await catalog()).assignments.find((s) => s.id === created).projectId, a.id);
  assert.equal(fixture.calls().find((c) => c.method === "thread/start").params.cwd, fixture.alpha);
  checks.push(
    "Separate project and working-folder controls, isolated same-folder project drafts, automatic new-session association",
  );
  // If association fails, the native session already created must be reused on retry.
  await go("/project?id=" + b.id);
  await page.locator('[data-wb="project-new"]').first().click();
  await page.locator("#prompt").fill("Retry association without duplicate session");
  await page.route("**/api/projects/assign", (route) =>
    route.fulfill({ status: 503, json: { error: "Project information is temporarily unavailable. Please retry." } }),
  );
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(
    () => document.querySelector("#prompt")?.value === "Retry association without duplicate session",
  );
  const failedThread = await page.evaluate(() => globalThis.__pandaForceDebug.state.active.id),
    starts = fixture.calls().filter((c) => c.method === "thread/start").length;
  await page.unroute("**/api/projects/assign");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await waitFor(async () => (await catalog()).assignments.find((s) => s.id === failedThread));
  assert.equal(fixture.calls().filter((c) => c.method === "thread/start").length, starts);
  assert.equal((await catalog()).assignments.find((s) => s.id === failedThread).projectId, b.id);
  checks.push("Failed association preserves the native session and safely retries without duplicate creation");
  // Real backend-to-browser server requests; no command is executed by this fixture.
  await go("/projects");
  const approval = {
    id: "native-approval-string",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "old-alpha",
      turnId: "approval-turn",
      itemId: "approval-command",
      command: "echo isolated approval",
      cwd: fixture.alpha,
      reason: "Verify the approval controls",
      availableDecisions: ["accept", "decline", "acceptForSession"],
    },
  };
  fixture.requestApproval(approval);
  await page.locator("#pendingApprovalNotice").waitFor({ state: "visible" });
  assert.equal(
    fixture.calls().some((c) => c.type === "response" && c.id === approval.id),
    false,
  );
  await page.locator("#pendingApprovalNotice").click();
  await page.locator("#approvalInboxDialog .approval-primary").click();
  const approved = await waitFor(() => fixture.calls().find((c) => c.type === "response" && c.id === approval.id));
  assert.deepEqual(approved.result, { decision: "accept" });
  await page.locator("#approvalInboxDialog").waitFor({ state: "hidden" });
  fixture.requestApproval({ ...approval, id: "modal-scoped-decision" });
  await page.locator("#pendingApprovalNotice").waitFor({ state: "visible" });
  await page.locator("#pendingApprovalNotice").click();
  const scoped = page.locator("#approvalInboxDialog .approval-actions-main .approval-scoped");
  assert.equal(
    await scoped.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
    true,
  );
  await scoped.click();
  const scopedResponse = await waitFor(() =>
    fixture.calls().find((c) => c.type === "response" && c.id === "modal-scoped-decision"),
  );
  assert.deepEqual(scopedResponse.result, { decision: "acceptForSession" });
  const legacy = {
    id: "legacy-approval",
    method: "execCommandApproval",
    params: {
      conversationId: "old-beta",
      callId: "legacy-call",
      command: ["echo", "legacy isolated"],
      cwd: fixture.beta,
      reason: "Verify legacy protocol",
    },
  };
  fixture.requestApproval(legacy);
  await page.locator("#pendingApprovalNotice").waitFor({ state: "visible" });
  await page.locator("#pendingApprovalNotice").click();
  await page.locator("#approvalInboxDialog .approval-deny").click();
  const denied = await waitFor(() => fixture.calls().find((c) => c.type === "response" && c.id === legacy.id));
  assert.deepEqual(denied.result, { decision: { denied: { rejection: "Declined in PandaForce" } } });
  checks.push(
    "Global approvals remain visible outside the session; native string IDs and legacy allow/deny payloads round-trip",
  );
  await go("/task/old-alpha");
  fixture.requestApproval({
    ...approval,
    id: "restore-and-retry",
    params: { ...approval.params, turnId: "restore-approval" },
  });
  await page.locator(".approval-card").waitFor();
  await page.locator(".approval-card").evaluate((card) => card.remove());
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.locator(".approval-card").waitFor();
  // Hold SSE during HTTP failure injection; a recovered WebSocket would bypass it.
  await page.routeWebSocket("**/ws", (socket) => socket.close());
  await page.evaluate(() => globalThis.__pandaForceDebug.state.ws?.close());
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.transport === "sse");
  let rejectDecision;
  let decisionAttempts = 0;
  await page.route("**/api/engine/respond", async (route) => {
    decisionAttempts++;
    await new Promise((resolve) => {
      rejectDecision = resolve;
    });
    await route.fulfill({ status: 503, json: { error: "Temporary transport failure" } });
  });
  await page.locator(".approval-primary").click();
  await waitFor(() => decisionAttempts === 1);
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.locator(".approval-card").waitFor();
  assert.equal(
    await page.locator(".approval-primary").isDisabled(),
    true,
    "A rebuilt card must retain its pending decision",
  );
  await page.locator(".approval-actions").dispatchEvent("submit");
  await page.waitForTimeout(50);
  assert.equal(decisionAttempts, 1, "Rebuilding a card must not allow a duplicate decision");
  rejectDecision();
  await page.locator(".approval-submit-error").waitFor();
  assert.equal(await page.locator(".approval-primary").isEnabled(), true);
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
  await page.locator(".approval-submit-error").waitFor();
  assert.equal(await page.locator(".approval-primary").isEnabled(), true);
  assert.equal(
    fixture.calls().some((c) => c.type === "response" && c.id === "restore-and-retry"),
    false,
  );
  await page.unroute("**/api/engine/respond");
  await page.locator(".approval-primary").click();
  await waitFor(() => fixture.calls().find((c) => c.type === "response" && c.id === "restore-and-retry"));
  checks.push(
    "Rebuilt approval cards retain pending and failed decisions, prevent duplicate submission, and support explicit retry",
  );
  const reasoning = await page.evaluate(() => {
    const api = globalThis.__pandaForceDebug;
    api.notify("item/started", {
      threadId: "old-alpha",
      turnId: "summary-turn",
      item: {
        id: "public-summary",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Visible native summary" }],
      },
    });
    api.notify("item/completed", {
      threadId: "old-alpha",
      turnId: "summary-turn",
      item: { id: "public-summary", type: "reasoning", summary: [] },
    });
    for (const id of ["empty-one", "empty-two"])
      api.notify("item/completed", {
        threadId: "old-alpha",
        turnId: "summary-turn",
        item: { id, type: "reasoning", summary: [], encrypted_content: "not-public" },
      });
    const row = document.querySelector('[data-item-id="public-summary"]');
    row.click();
    return {
      text: row.nextElementSibling.textContent,
      expanded: row.getAttribute("aria-expanded"),
      emptyVisible: ["empty-one", "empty-two"].some(
        (id) => !document.querySelector('[data-item-id="' + id + '"]').hidden,
      ),
      privateVisible: document.body.textContent.includes("not-public"),
    };
  });
  assert.ok(reasoning.text.includes("Visible native summary"));
  assert.equal(reasoning.expanded, "true");
  assert.equal(reasoning.emptyVisible, false);
  assert.equal(reasoning.privateVisible, false);
  checks.push(
    "Public native reasoning blocks expand, streamed summaries survive completion, empty duplicate placeholders are suppressed",
  );
  await go("/projects");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.screenshot({ path: artifacts + "/projects-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
  await page.locator('[data-wb="create-project"]').first().click();
  await page.getByRole("heading", { name: "创建项目", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: artifacts + "/project-form-mobile-zh.png", fullPage: true });
  await page.locator("#projectDialog [data-project-close]").click();
  checks.push("Responsive projects/forms and Chinese UI with English fallback");
  const mobileApproval = {
    ...approval,
    id: "mobile-inbox",
    params: { ...approval.params, command: "echo " + "long-command-argument".repeat(12) },
  };
  fixture.requestApproval(mobileApproval);
  await page.locator("#pendingApprovalNotice").waitFor({ state: "visible" });
  await page.locator("#pendingApprovalNotice").click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const selector of [".approval-primary", ".approval-deny"]) {
      const button = page.locator("#approvalInboxDialog " + selector),
        bounds = await button.boundingBox();
      assert.ok(bounds && bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= width);
    }
    assert.equal(await page.locator("#approvalInboxDialog").evaluate((el) => el.scrollWidth > el.clientWidth), false);
  }
  await page.screenshot({ path: artifacts + "/approval-inbox-mobile-zh.png", fullPage: true });
  await page.locator("#approvalInboxDialog .approval-deny").click();
  await waitFor(() => fixture.calls().find((c) => c.type === "response" && c.id === mobileApproval.id));
  checks.push("Global approval controls remain visible and touch-sized at 320/390 pixels with long commands");
  assert.deepEqual(errors, []);
  const result = { result: "passed", checks, errors };
  await writeFile(artifacts + "/browser-results.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await fixture.dispose();
}
