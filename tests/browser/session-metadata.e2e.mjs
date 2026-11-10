import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";

const directory = ".artifacts/session-metadata";
await mkdir(directory, { recursive: true });
const checks = [];
for (const [engine, width] of [
  [chromium, 1440],
  [webkit, 390],
]) {
  const fixture = await createAppFixture({ unnamedSessions: true });
  const browser = await engine.launch({ headless: true, ...(width > 600 ? { args: ["--no-sandbox"] } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en" });
    await fixture.signIn(context);
    const snapshot = await (await context.request.get(fixture.base + "/api/projects")).json();
    const response = await context.request.post(fixture.base + "/api/projects", {
      headers: { origin: fixture.base },
      data: { revision: snapshot.revision, name: "Metadata project", code: "metadata" },
    });
    assert.equal(response.ok(), true, await response.text());
    const project = (await response.json()).projects[0];
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(fixture.base + "/new");
    await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.models.length > 0);
    await page.evaluate(() => (globalThis.__metadataDocument = true));
    const preview = "Review the current build status";
    await page.locator("#prompt").fill(preview);
    await page.locator("#sendButton").click();
    await page.waitForURL("**/task/**");
    await page.waitForFunction((preview) => globalThis.__pandaForceDebug.state.active?.preview === preview, preview);
    // Native engines can update the preview without emitting a name notification.
    await page.waitForFunction((preview) => document.querySelector("#threadTitle").textContent === preview, preview);
    const id = await page.evaluate(() => globalThis.__pandaForceDebug.state.active.id);
    assert.equal(await page.locator(`.thread-item[data-id="${id}"] .thread-name`).textContent(), preview);
    assert.equal(await page.evaluate(() => globalThis.__metadataDocument), true);
    checks.push(`${width}: unnamed session title follows native preview polling without a reload`);

    await page.evaluate((id) => globalThis.__pandaForceDebug.workbench.navigate("/project?id=" + id), project.id);
    if (width < 600) await page.locator("#workspaceNavigationToggle").click();
    await page.locator("#newTask").click();
    await page.waitForURL("**/new?project=" + project.id);
    assert.equal(await page.locator("#sessionProjectSelect").inputValue(), project.id);
    assert.equal(await page.locator("#composerProjectButton").isDisabled(), true);
    assert.equal(
      await page.evaluate(() => globalThis.__pandaForceDebug.state.workspaceContext.cwd),
      project.workspace.path,
    );
    await page.evaluate((id) => globalThis.__pandaForceDebug.workbench.navigate("/project?id=" + id), project.id);
    await page.locator('.wb-empty [data-wb="new"]').click();
    assert.equal(await page.locator("#sessionProjectSelect").inputValue(), project.id);
    await page.locator("#prompt").fill("A session owned by the selected project");
    await page.locator("#sendButton").click();
    await page.waitForURL("**/task/**");
    const created = await page.evaluate(() => globalThis.__pandaForceDebug.state.active.id);
    const catalog = await (await context.request.get(fixture.base + "/api/projects")).json();
    assert.equal(catalog.assignments.find((item) => item.id === created)?.projectId, project.id);
    assert.equal(
      fixture
        .calls()
        .filter((item) => item.method === "thread/start")
        .at(-1).params.cwd,
      project.workspace.path,
    );
    await page.waitForFunction(
      () => document.querySelector("#sessionHeadingProject").textContent === "Metadata project",
    );
    checks.push(`${width}: global New session inherits the project page and creates in its managed directory`);

    await page.evaluate((id) => globalThis.__pandaForceDebug.workbench.navigate("/project?id=" + id), project.id);
    await page.locator('[data-wb="project-new"]').click();
    assert.equal(await page.locator("#sessionProjectSelect").inputValue(), project.id);
    await page.locator("#sessionProjectSelect").selectOption("");
    assert.equal(await page.locator("#sessionProjectSelect").inputValue(), "");
    assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.newSessionProjectId), null);
    checks.push(`${width}: explicit project creation preselects the project and still allows intentional unassignment`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${directory}/${width}.png` });
  } finally {
    await browser.close();
    await fixture.dispose();
  }
}
await writeFile(`${directory}/checks.json`, JSON.stringify(checks, null, 2) + "\n");
console.log(checks.join("\n"));
