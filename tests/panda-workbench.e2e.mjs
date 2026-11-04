import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProjectVisibilityFixture } from "./project-visibility-fixture.mjs";
const fixture = await createProjectVisibilityFixture(),
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const artifacts = process.env.PANDA_I1_ARTIFACTS || ".artifacts/panda-force-i1";
await mkdir(artifacts, { recursive: true });
const result = { checks: [], errors: [], overflows: [], timings: {} };
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en",
    colorScheme: "light",
  });
  await fixture.signIn(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => result.errors.push(e.message));
  const start = Date.now();
  await page.goto(fixture.base + "/workspace");
  await page.locator(".wb-task-row").first().waitFor();
  result.timings.coldWorkspaceMs = Date.now() - start;
  assert.equal(await page.title(), "PandaForce · Workspace");
  assert.equal(await page.locator(".workbench-navigation>button").count(), 6);
  assert.equal(await page.locator(".window-brand strong").isVisible(), true);
  assert.equal(await page.locator(".wb-metrics button").count(), 3);
  assert.equal(await page.locator("#workbenchComposerSlot #composer").isVisible(), true);
  assert.equal((await context.request.get(fixture.base + "/workbench.css")).status(), 200);
  result.checks.push("Real workbench shell, navigation, metrics and authenticated style assets");
  await page.keyboard.press("Control+k");
  await page.locator("#wbCommandQuery").fill("Old alpha");
  await page.locator("#wbCommandResults [data-wb=task]").click();
  await page.waitForURL("**/task/old-alpha");
  await page.locator("#conversation").waitFor({ state: "visible" });
  await page.reload();
  await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.active?.id === "old-alpha");
  await page.locator(".workbench-navigation [data-route=workspace]").click();
  assert.equal(await page.locator("#workbenchComposerSlot #composer").isVisible(), true);
  await page.keyboard.press("Control+Shift+k");
  await page.waitForURL(url => url.pathname === "/new");
  assert.equal(await page.locator("#composer").isVisible(), true);
  result.checks.push("Search shortcut, task deep-link reload, return to workspace and replacement new-task shortcut");
  const apiProjects = async (body) => {
    const response = await context.request.post(fixture.base + "/api/projects", { data: body });
    assert.equal(response.status(), 201); return response.json();
  };
  let catalog = await (await context.request.get(fixture.base + "/api/projects")).json();
  catalog = await apiProjects({ name: "Alpha product", code: "alpha-product", revision: catalog.revision });
  const alphaProject = catalog.projects.find(p => p.code === "alpha-product");
  catalog = await apiProjects({ name: "Beta product", code: "beta-product", revision: catalog.revision });
  const betaProject = catalog.projects.find(p => p.code === "beta-product");
  await page.locator(".workbench-navigation [data-route=projects]").click();
  await page.locator(`[data-wb=project][data-project-id="${alphaProject.id}"]`).click();
  await page.locator("[data-wb=project-new]").click();
  await page.locator("#prompt").fill("Alpha project draft");
  await page.locator("#sessionProjectSelect").selectOption(betaProject.id);
  assert.equal(await page.locator("#prompt").inputValue(), "");
  await page.locator("#prompt").fill("Beta project draft");
  await page.locator("#sessionProjectSelect").selectOption(alphaProject.id);
  assert.equal(await page.locator("#prompt").inputValue(), "Alpha project draft");
  result.checks.push("Explicit product project context and isolated drafts between projects in the same working folder");
  await page.locator(".workbench-navigation [data-route=projects]").click();
  await page.locator(`[data-wb=pin][data-project-id="${betaProject.id}"]`).click();
  await page.waitForFunction(id => JSON.parse(localStorage.getItem("codex-webui-sidebar-pinned-projects") || "[]").includes("project:" + id), betaProject.id);
  await page.locator('[data-wb="create-project"]').first().click();
  await page.locator("#projectNameInput").fill("A manually created project");
  await page.locator("#projectCodeInput").fill("manual-project");
  await page.locator('#projectForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({state:"hidden"});
  await page.reload();
  await page.getByRole("heading", { name: "A manually created project", exact: true }).waitFor();
  await page.locator('[data-wb="project-new"]').first().click();
  await page.locator("#composerProjectButton").click();
  await page.locator("#folderPathInput").fill(fixture.dir);
  await page.locator("#folderGo").click();
  await page.waitForFunction(path => document.querySelector("#folderSelection").textContent === path, fixture.dir);
  await page.locator("#folderConfirm").click();
  await page.locator(".workbench-navigation [data-route=projects]").click();
  assert.equal(await page.locator(".wb-project-main").count(), 3);
  result.checks.push("Project pinning, explicit creation/persistence, and independent working-folder selection");
  const outside = await context.request.get(fixture.base + "/api/workspace/context?cwd=" + encodeURIComponent("/tmp"));
  assert.ok([400, 403].includes(outside.status()));
  const traversal = await context.request.get(
    fixture.base + "/api/folders?path=" + encodeURIComponent(fixture.dir + "/../../../../tmp"),
  );
  assert.ok([400, 403].includes(traversal.status()));
  result.checks.push("Server-enforced project path and traversal boundary");
  await page.locator(".workbench-navigation [data-route=settings]").click();
  await page.locator("#settingsDialog").waitFor();
  assert.equal(await page.locator("[data-settings-group]:visible").count(), 5);
  assert.equal(await page.locator("[data-settings-page]").count(), 18);
  await page.locator("[data-settings-group=appearance] summary").click();
  await page.locator("[data-settings-page=appearance]").click();
  await page.locator("#themeSelect").selectOption("dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.locator("#languageSelect").selectOption("zh-CN");
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
  await page.locator("#themeSelect").selectOption("light");
  await page.locator("#closeSettingsNav").click();
  await page.waitForURL("**/projects");
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("heading", { name: "项目", exact: true }).waitFor();
  result.checks.push(
    "All legacy settings retained in five groups; real language/theme persistence and return navigation",
  );
  await page.goto(fixture.base + "/settings/profile");
  await page.locator("#settingsProductIdentity").waitFor();
  assert.equal(await page.locator("#settingsProductIdentity").innerText(), "fixture-owner");
  assert.ok((await page.locator("[data-settings-content=profile]").innerText()).includes("Codex"));
  result.checks.push("Product identity remains accessible without model authentication");
  await page.goto(fixture.base + "/workspace");
  await page.locator(".wb-hero h1").waitFor();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await page.screenshot({ path: join(artifacts, "workspace-zh-light.png") });
  await page.evaluate(() => globalThis.__codexWebuiI18n.setPreference("en"));
  await page.screenshot({ path: join(artifacts, "workspace-en-light.png") });
  await page.locator(".workbench-top-tools [data-wb=theme]").click();
  await page.screenshot({ path: join(artifacts, "workspace-en-dark.png") });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["workspace", "tasks", "projects", "connections", "settings/appearance"]) {
      await page.goto(fixture.base + "/" + route);
      await page.waitForFunction(() => Boolean(globalThis.__codexWebuiDebug?.workbench));
      await page.waitForTimeout(70);
      const rect = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      if (rect.scroll > rect.width) result.overflows.push({ route, ...rect });
    }
  }
  result.checks.push("Five widths across navigation, projects, connections and settings");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    colorScheme: "light",
  });
  await fixture.signIn(mobile);
  const mp = await mobile.newPage();
  mp.on("pageerror", (e) => result.errors.push(e.message));
  await mp.goto(fixture.base + "/workspace");
  await mp.locator(".wb-hero").waitFor();
  assert.equal(await mp.locator(".workbench-mobile-nav").isVisible(), true);
  await mp.locator(".workbench-mobile-nav [data-route=projects]").click();
  await mp.getByRole("heading", { name: "项目", exact: true }).waitFor();
  await mp.locator("#workspacePreparation").waitFor({ state: "hidden" });
  await mp.screenshot({ path: join(artifacts, "projects-mobile.png") });
  await mp.locator(".workbench-mobile-nav [data-route=settings]").click();
  await mp.locator("#settingsSearch").fill("语言");
  await mp.locator("[data-settings-page=appearance]").click();
  await mp.locator("#languageSelect").waitFor({ state: "visible" });
  await mp.screenshot({ path: join(artifacts, "settings-mobile.png") });
  result.checks.push("Touch/mobile navigation and settings flow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(fixture.base + "/workspace");
  await page.locator(".wb-hero h1").waitFor();
  await page.keyboard.press("Control+k");
  await page.locator("#wbCommandQuery").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#workbenchDialog").isVisible(), false);
  result.checks.push("Native dialog keyboard dismissal and focus recovery");
  const fallbackContext = await browser.newContext({ locale: "fr-FR", viewport: { width: 1280, height: 900 } });
  await fixture.signIn(fallbackContext);
  const fp = await fallbackContext.newPage();
  await fp.goto(fixture.base + "/workspace");
  await fp.locator(".wb-hero h1").waitFor();
  assert.equal(await fp.locator("html").getAttribute("lang"), "en");
  result.checks.push("Unsupported browser locale falls back to English");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.overflows, []);
  result.result = "passed";
  await writeFile(join(artifacts, "browser-results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await fixture.dispose();
}
