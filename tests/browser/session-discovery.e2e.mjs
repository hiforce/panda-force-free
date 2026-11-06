import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createAppFixture } from "../support/app-fixture.mjs";
const fixture = await createAppFixture({ historySessions: 140 });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ locale: "en", viewport: { width: 1440, height: 1000 } });
  await fixture.signIn(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.base + "/projects");
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  const unassigned = page.locator('[data-project="__tasks__"]');
  if ((await unassigned.locator(".sidebar-project-row").getAttribute("aria-expanded")) !== "true")
    await unassigned.locator(".sidebar-project-row").click();
  assert.equal(await unassigned.locator(".thread-item").count(), 10);
  await unassigned.locator('[data-session-browse-view="recent"]').waitFor({ state: "visible" });
  assert.match(await unassigned.locator('[data-session-browse-view="recent"]').innerText(), /^Recent\s+10$/);
  assert.equal(await unassigned.locator('[data-session-browse-view="folders"]').innerText(), "Folders");
  await unassigned.locator('[data-session-browse-view="folders"]').click();
  await unassigned.locator(`[data-session-directory="${fixture.alpha}"]`).click();
  await unassigned.locator(".sidebar-folder-sessions[aria-busy=false]").waitFor();
  const alphaFolder = unassigned.locator(`[data-session-directory="${fixture.alpha}"]`);
  assert.equal(await alphaFolder.getAttribute("aria-expanded"), "true");
  assert.equal(await alphaFolder.evaluate((node) => node === document.activeElement), true);
  const typography = await page.evaluate(() => {
    const font = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    const path = document.querySelector(".sidebar-session-directory-path");
    return {
      navigation: font(".workbench-navigation > button"),
      session: font(".sidebar-folder-sessions .thread-name"),
      folder: font(".sidebar-session-directory strong"),
      metadata: font(".sidebar-session-directory-path"),
      overflow: getComputedStyle(path).textOverflow,
      connection: document.querySelector('.workbench-navigation [data-route="connections"] svg').innerHTML,
      settings: document.querySelector('.workbench-navigation [data-route="settings"] svg').innerHTML,
    };
  });
  assert.ok(typography.navigation > typography.session && typography.session > typography.metadata);
  assert.equal(typography.folder, typography.session);
  assert.equal(typography.overflow, "ellipsis");
  assert.notEqual(typography.connection, typography.settings);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await alphaFolder.getAttribute("aria-expanded"), "false");
  assert.equal(await unassigned.locator(".thread-item").count(), 0);
  await page.keyboard.press("ArrowRight");
  await unassigned.locator(".sidebar-folder-sessions[aria-busy=false]").waitFor();
  assert.equal(await alphaFolder.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await unassigned.locator(".sidebar-folder-sessions[aria-busy=false]").waitFor();
  assert.equal(await alphaFolder.getAttribute("aria-expanded"), "false");
  await alphaFolder.click();
  await unassigned.locator(".sidebar-folder-sessions[aria-busy=false]").waitFor();
  await mkdir(".artifacts/sidebar-design", { recursive: true });
  await page.locator("#sidebar").screenshot({ path: ".artifacts/sidebar-design/folders-en.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#toggleSidebar").click();
  await page.waitForFunction(() => {
    const box = document.querySelector("#sidebar").getBoundingClientRect();
    return box.x >= -1 && box.right <= innerWidth + 1;
  });
  const touch = await alphaFolder.boundingBox();
  assert.ok(touch.height >= 44 && touch.x >= -1 && touch.x + touch.width <= 391, JSON.stringify(touch));
  await page.locator("#sidebar").screenshot({ path: ".artifacts/sidebar-design/folders-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    await globalThis.__pandaForceI18n.setPreference("zh-CN");
  });
  assert.equal(await unassigned.locator('[data-session-directory=""] strong').textContent(), "不指定工作目录");
  assert.equal(await page.locator("#accountName").textContent(), "设置");
  await page.locator("#sidebar").screenshot({ path: ".artifacts/sidebar-design/folders-zh.png" });
  await page.evaluate(async () => {
    await globalThis.__pandaForceI18n.setPreference("en");
  });
  assert.equal(await unassigned.locator('.thread-item[data-id="old-beta"]').count(), 0);
  await unassigned.locator(".sidebar-sessions-more").click();
  await unassigned.locator('.thread-item[data-id="historic-139"]').waitFor();
  await page.locator('[data-wb="create-project"]').first().click();
  await page.locator("#projectNameInput").fill("Discovery acceptance");
  await page.locator("#projectCodeInput").fill("discovery");
  await page.locator('#projectForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({ state: "hidden" });
  await page.locator('[data-wb="project-link"]').click();
  await page.locator("#associationDirectory").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#associationDirectory").disabled);
  await page.locator("#associationDirectory").selectOption(JSON.stringify(fixture.beta));
  await page.locator('#associationSessions input[value="old-beta"]').check();
  assert.equal(await page.locator('#associationSessions input[value="old-alpha"]').count(), 0);
  await page.locator("#associationDirectory").selectOption(JSON.stringify(fixture.alpha));
  await page.locator("#associationSearch").fill("Historical session 139");
  await page.locator('#associationSessions input[value="historic-139"]').check();
  assert.match(await page.locator("#associationCount").innerText(), /2/);
  await page.locator('#projectAssociationForm [type="submit"]').click();
  await page.locator("#projectDialog").waitFor({ state: "hidden" });
  const snapshot = await (await context.request.get(fixture.base + "/api/projects")).json();
  assert.deepEqual(snapshot.assignments.map((entry) => entry.id).sort(), ["historic-139", "old-beta"]);
  await page.locator("#projectSessionSearch").fill("139");
  assert.equal(await page.locator("#projectSessionResults .wb-task-row").count(), 1);
  await page.locator("#projectSessionDirectory").selectOption(fixture.beta);
  assert.equal(await page.locator("#projectSessionResults .wb-task-row").count(), 0);
  await page.locator("#projectSessionSearch").fill("");
  assert.equal(await page.locator('#projectSessionResults .wb-task-row[data-id="old-beta"]').count(), 1);
  await page.locator("#projectSessionDirectory").selectOption(fixture.alpha);
  assert.equal(await page.locator('#projectSessionResults .wb-task-row[data-id="historic-139"]').count(), 1);
  await unassigned.locator(`[data-session-directory="${fixture.alpha}"]`).click();
  const alphaCount = unassigned.locator(`[data-session-directory="${fixture.alpha}"] small`);
  const countBefore = Number(await alphaCount.innerText());
  const olderLinkSnapshot = await (await context.request.get(fixture.base + "/api/projects")).json();
  const olderLinked = await context.request.post(fixture.base + "/api/projects/assign", {
    data: {
      projectId: olderLinkSnapshot.projects[0].id,
      revision: olderLinkSnapshot.revision,
      sessionIds: ["historic-100"],
    },
  });
  assert.equal(olderLinked.status(), 200);
  await page.waitForFunction(
    ({ path, expected }) =>
      Number(
        [...document.querySelectorAll("[data-session-directory]")]
          .find((el) => el.dataset.sessionDirectory === path)
          ?.querySelector("small")?.textContent,
      ) === expected,
    { path: fixture.alpha, expected: countBefore - 1 },
  );
  const history = await (await context.request.get(fixture.base + "/api/projects/history")).json();
  const current = await (await context.request.get(fixture.base + "/api/projects")).json();
  const linked = await context.request.post(fixture.base + "/api/projects/assign", {
    data: {
      projectId: current.projects[0].id,
      revision: current.revision,
      sessionIds: history.sessions.slice(0, 50).map((session) => session.id),
    },
  });
  assert.equal(linked.status(), 200);
  await page.reload();
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  if ((await unassigned.locator(".sidebar-project-row").getAttribute("aria-expanded")) !== "true")
    await unassigned.locator(".sidebar-project-row").click();
  await unassigned.locator('[data-session-browse-view="recent"]').click();
  assert.equal(await unassigned.locator(".thread-item").count(), 0);
  await unassigned.locator('[data-session-browse-view="folders"]').click();
  await unassigned.locator(`[data-session-directory="${fixture.alpha}"]`).click();
  await unassigned.locator('.thread-item[data-id="historic-70"]').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Session discovery: ten recent sessions, full directory history, combined filters and retained selections passed",
  );
} finally {
  await browser.close();
  await fixture.dispose();
}
