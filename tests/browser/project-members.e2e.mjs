import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { smtpFixture } from "../support/smtp-fixture.js";

const output = process.env.PANDA_MEMBERS_PROOF || ".artifacts/project-members";
await mkdir(output, { recursive: true });
const mail = await smtpFixture();
let app;
try {
  app = await createAppFixture({
    freshAdministrator: true,
    startupTimeoutMs: 60_000,
    extraEnvironment({ dir }) {
      const config = join(dir, "fixture-content-access.json");
      if (!existsSync(config)) writeFileSync(config, JSON.stringify({ schema: 1, mode: "shared", administrators: [] }));
      return { PANDA_FORCE_CONTENT_ACCESS_CONFIG_FILE: config };
    },
  });
  const password = "Fixture-members-pass-123";
  const call = (actor, path, body, method = body === undefined ? "GET" : "POST") =>
    fetch(app.base + path, {
      method,
      headers: { ...(actor ? { cookie: actor } : {}), origin: app.base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cookie = (response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  const browserCookies = (header) =>
    header.split("; ").map((item) => {
      const split = item.indexOf("=");
      return { name: item.slice(0, split), value: item.slice(split + 1), url: app.base };
    });
  const api = async (who, path, body, method) => {
    const response = await call(who, path, body, method);
    assert(response.ok, path + " " + response.status + " " + (await response.clone().text()));
    return response.json();
  };
  const setup = await call("", "/api/auth/setup", { username: "fixture-admin", password });
  assert(setup.ok, await setup.clone().text());
  const admin = cookie(setup);
  if ((await api(admin, "/api/system/database")).initialChoiceRequired)
    await api(admin, "/api/system/database/selection", { driver: "sqlite" });
  await api(admin, "/api/local-users/mail", { ...mail.config, revision: 0, publicUrl: app.base }, "PUT");
  async function invite(name, role = "member") {
    const email = name + "@example.com";
    const index = mail.messages.length;
    await api(admin, "/api/local-users", { email, role, operationId: crypto.randomUUID() });
    const message = await waitFor(() => mail.messages[index]);
    const url = new URL(message.html.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&"));
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    await api("", "/api/local-users/invitation/accept", { token, password });
    const response = await call("", "/api/auth/login", { username: email, password });
    assert(response.ok);
    return { email, cookie: cookie(response) };
  }
  const creator = await invite("creator");
  const member = await invite("colleague");
  const outsider = await invite("outsider", "admin");
  const projectList = (who) => api(who, "/api/projects").then((result) => result.projects);
  const waitProject = async (who, id) => (await projectList(who)).find((project) => project.id === id);
  const owner = (await api(creator.cookie, "/api/content-access")).owner;
  const selection = await api(creator.cookie, "/api/projects/members");
  const creatorOption = selection.members.find((item) => item.creator);
  assert(creatorOption?.selected);
  assert.equal(typeof creatorOption.username, "string");
  const memberOption = (await api(member.cookie, "/api/projects/members")).members.find((item) => item.creator);

  async function legacyProject(code, who, keepReceipt = true) {
    const { revision } = await api(who, "/api/projects");
    const created = await api(who, "/api/projects", { name: code, code, revision, operationId: crypto.randomUUID() });
    const project = created.projects.find((item) => item.code === code);
    assert(project);
    const db = new Database(join(app.dir, "panda-state", "data", "projects.sqlite"));
    try {
      // Reproduce the persisted catalogue and grant history from before owners were recorded.
      db.transaction(() => {
        db.query("DELETE FROM content_access_project_owners WHERE project=?").run(project.id);
        if (!keepReceipt) db.query("DELETE FROM project_workspace_creations WHERE projectId=?").run(project.id);
      }).immediate();
    } finally {
      db.close();
    }
    return project.id;
  }

  for (const [engine, width, locale, relevantText] of [
    [chromium, 1440, "en", "Project members"],
    [webkit, 320, "zh-HK", "項目成員"],
  ]) {
    const name = "Private telescope project " + locale;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        locale,
        viewport: { width, height: 850 },
        isMobile: width < 760,
        hasTouch: width < 760,
      });
      await context.addCookies(browserCookies(creator.cookie));
      await context.addInitScript((language) => {
        localStorage.setItem("panda-force-locale", language);
        localStorage.setItem("panda-force-theme", language === "en" ? "light" : "aurora");
      }, locale);
      const page = await context.newPage();
      let failFirst = true;
      await page.route("**/api/projects/members", (route) => {
        if (!failFirst) return route.continue();
        failFirst = false;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      });
      await page.goto(app.base + "/projects");
      await page.locator(".project-directory-create").click();
      const form = page.locator("#projectForm");
      await form.locator("#projectNameInput").fill(name);
      const retry = form.locator("[data-project-member-retry]");
      await retry.click();
      assert.equal(await form.locator("#projectNameInput").inputValue(), name);
      await form.locator("#projectCodeInput").fill("telescope-" + locale.toLowerCase());
      await form.locator("#projectDescriptionInput").fill("A private workspace for telescope calibration.");
      const choices = form.locator("[data-project-member-list]");
      const creatorBox = choices.locator(`input[value="${creatorOption.id}"]`);
      await creatorBox.waitFor();
      assert(await creatorBox.isChecked());
      assert(await creatorBox.isDisabled());
      assert.equal(await form.locator("legend").innerText(), relevantText);
      const colleagueBox = choices.locator(`input[value="${memberOption.id}"]`);
      if (width === 1440) {
        await colleagueBox.focus();
        await page.keyboard.press("Space");
      } else await colleagueBox.check();
      assert(await colleagueBox.isChecked());
      await form.locator("[data-project-members]").scrollIntoViewIfNeeded();
      assert(
        await page.locator("#projectDialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      );
      await page.screenshot({ path: join(output, locale + "-create-" + width + ".png") });
      await form.locator("button[type=submit]").click();
      await page.waitForURL(/\/project\?id=/);
      const id = new URL(page.url()).searchParams.get("id");
      assert(id);
      assert((await waitProject(creator.cookie, id))?.canManageMembers);
      assert(await waitProject(member.cookie, id));
      assert.equal(await waitProject(outsider.cookie, id), undefined);
      const treePath = "/api/project-document-tree?" + new URLSearchParams({ project: id });
      assert.equal((await api(member.cookie, treePath)).projectId, id);
      assert.equal((await call(outsider.cookie, treePath)).status, 404);
      assert.equal(await waitProject(admin, id), undefined);
      assert.equal((await call(outsider.cookie, "/api/projects/workspace", { projectId: id })).status, 404);
      assert.equal((await call(outsider.cookie, "/api/projects/" + id + "/memory-team")).status, 404);
      const membersPath = "/api/projects/members?" + new URLSearchParams({ project: id });
      assert.deepEqual(await api(member.cookie, membersPath), { editable: false, revision: null, members: [] });
      const { revision } = await api(creator.cookie, membersPath);
      assert.equal((await call(member.cookie, membersPath, { members: [], revision }, "PUT")).status, 404);
      for (const role of [null, "reader", "blocked"]) {
        assert.equal(
          (await call(admin, "/api/content-access/grants", { project: id, owner, role, revision }, "PUT")).status,
          403,
        );
      }
      await page.locator('[data-wb="project-edit"]').click();
      await creatorBox.waitFor();
      assert(await creatorBox.isDisabled());
      await colleagueBox.uncheck();
      await form.locator("[data-project-member-save]").click();
      await waitFor(async () => !(await waitProject(member.cookie, id)));
      assert((await waitProject(creator.cookie, id))?.canManageMembers);
      await form
        .locator("[data-project-member-status]")
        .getByText(locale === "en" ? "Members saved." : "已儲存成員。")
        .waitFor();
      await page.screenshot({ path: join(output, locale + "-edit-" + width + ".png") });
      assert.equal(
        (await call(creator.cookie, membersPath, { members: [memberOption.id], revision }, "PUT")).status,
        409,
      );
      const current = await api(creator.cookie, membersPath);
      assert(current.members.some((entry) => entry.creator && entry.selected));
      assert(current.members.some((entry) => entry.id === memberOption.id && !entry.selected));

      const legacy = await legacyProject("existing-telescope-" + locale.toLowerCase(), creator.cookie);
      const legacyMembers = "/api/projects/members?" + new URLSearchParams({ project: legacy });
      assert(await waitProject(outsider.cookie, legacy));
      const reserved = await api(creator.cookie, legacyMembers);
      assert(reserved.legacy && reserved.editable && !reserved.chooseOwner);
      assert(reserved.members.some(({ creator, selected }) => creator && selected));
      assert.equal((await api(admin, legacyMembers)).editable, false);
      assert.equal(
        (await call(admin, legacyMembers, { members: [], revision: reserved.revision, ownerId: "installation" }, "PUT"))
          .status,
        404,
      );
      assert.equal(
        (
          await call(
            creator.cookie,
            legacyMembers,
            { members: [], revision: reserved.revision, ownerId: memberOption.id },
            "PUT",
          )
        ).status,
        400,
      );
      await page.goto(app.base + "/project?" + new URLSearchParams({ id: legacy }));
      await page.locator('[data-wb="project-edit"]').click();
      await creatorBox.waitFor();
      assert(await creatorBox.isDisabled());
      assert(await form.locator("[data-project-legacy-members]").isVisible());
      assert(!(await form.locator("[data-project-owner-picker]").isVisible()));
      await colleagueBox.check();
      await page.screenshot({ path: join(output, locale + "-legacy-" + width + ".png") });
      await form.locator("[data-project-member-save]").click();
      await waitFor(async () => !(await waitProject(outsider.cookie, legacy)));
      assert(await waitProject(member.cookie, legacy));
      assert(!(await api(creator.cookie, legacyMembers)).legacy);
      assert.equal(
        (await call(creator.cookie, legacyMembers, { members: [], revision: reserved.revision }, "PUT")).status,
        409,
      );

      const unverified = await legacyProject("imported-telescope-" + locale.toLowerCase(), creator.cookie, false);
      const importedMembers = "/api/projects/members?" + new URLSearchParams({ project: unverified });
      assert.equal((await api(creator.cookie, importedMembers)).editable, false);
      const imported = await api(admin, importedMembers);
      assert(imported.legacy && imported.chooseOwner && imported.editable);
      assert(imported.members.every(({ creator }) => !creator));
      assert.equal(
        (await call(admin, importedMembers, { members: [], revision: imported.revision }, "PUT")).status,
        400,
      );
      assert(await waitProject(outsider.cookie, unverified));
      await context.clearCookies();
      await context.addCookies(browserCookies(admin));
      await page.goto(app.base + "/project?" + new URLSearchParams({ id: unverified }));
      await page.locator('[data-wb="project-edit"]').click();
      const ownerPicker = form.locator("[data-project-owner-picker]");
      const enable = form.locator("[data-project-member-save]");
      await ownerPicker.waitFor();
      assert(await enable.isDisabled());
      await ownerPicker.selectOption(creatorOption.id);
      assert((await creatorBox.isDisabled()) && (await creatorBox.isChecked()));
      await colleagueBox.check();
      await choices.locator('input[value="installation"]').uncheck();
      await page.screenshot({ path: join(output, locale + "-assign-owner-" + width + ".png") });
      await enable.click();
      await waitFor(async () => !(await waitProject(outsider.cookie, unverified)));
      assert.equal((await api(admin, importedMembers)).editable, false);
      assert(
        (await api(creator.cookie, importedMembers)).members.some(
          ({ creator, id }) => creator && id === creatorOption.id,
        ),
      );
      assert.equal(await waitProject(outsider.cookie, unverified), undefined);
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Project creation and legacy member management passed on PC and narrow H5 with owner verification, explicit assignment and direct-access fences.",
  );
} finally {
  await app?.dispose();
  await mail.close();
}
