import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { idaasContentFixture, contentFixtureOwner } from "../support/idaas-content-fixture.mjs";

const app = await idaasContentFixture(),
  out = ".artifacts/content-access-browser";
await mkdir(out, { recursive: true });
const { chromium, webkit } = await import("playwright");
try {
  const admin = await app.login("admin");
  const json = async (path, body, method) => {
    const response = await app.api(admin, path, body, method);
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  };
  let catalog = await json("/api/projects");
  catalog = await json("/api/projects", {
    code: "access-design",
    name: "Design documents",
    revision: catalog.revision,
  });
  const project = catalog.projects.find((p) => p.code === "access-design").id;
  for (const [engine, width, locale, account] of [
    [chromium, 1440, "en", "admin"],
    [webkit, 390, "zh-CN", "admin"],
    [webkit, 320, "en", "alice"],
    [chromium, 767, "en", "admin"],
  ]) {
    const browser = await engine.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width, height: 1100 },
        locale,
        colorScheme: width === 1440 ? "light" : "dark",
      });
    try {
      const cookie = await app.login(account),
        separator = cookie.indexOf("=");
      await context.addCookies([
        { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: app.base, httpOnly: true },
      ]);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.base + "/settings/client-access", { waitUntil: "domcontentloaded" });
      await page.locator("[data-cli-form]").waitFor();
      const panel = page.locator("[data-content-access]");
      assert.equal(await panel.getAttribute("open"), null);
      await panel.locator("summary").click();
      assert.equal(await panel.locator("[data-access-self]").textContent(), contentFixtureOwner(account));
      if (account === "admin") {
        const member = panel.locator('[name="pf-access-owner"]'),
          role = panel.locator('[name="pf-access-role"]');
        await page.waitForFunction(() => !document.querySelector("[data-access-fields]").disabled);
        await member.fill(contentFixtureOwner("alice"));
        await role.selectOption("reader");
        const save = page.waitForResponse(
          (r) => r.url().endsWith("/api/content-access/grants") && r.request().method() === "PUT",
        );
        await panel.locator('button[type="submit"]').click();
        assert.equal((await save).status(), 200);
        await page.waitForFunction(() => !document.querySelector("[data-access-fields]").disabled);
        assert.equal(await panel.locator("[data-access-grants] li").count(), 2);
        const savedGrants = await json("/api/content-access/grants?project=" + project);
        assert.deepEqual(
          savedGrants.grants.map(({ owner, role }) => ({ owner, role })).sort((a, b) => a.owner.localeCompare(b.owner)),
          [
            { owner: contentFixtureOwner("admin"), role: "contributor" },
            { owner: contentFixtureOwner("alice"), role: "reader" },
          ].sort((a, b) => a.owner.localeCompare(b.owner)),
        );
        if (width === 1440) {
          const grants = await json("/api/content-access/grants?project=" + project);
          await json(
            "/api/content-access/grants",
            { project, owner: contentFixtureOwner("bob"), role: "blocked", revision: grants.revision },
            "PUT",
          );
          await role.selectOption("contributor");
          const conflict = page.waitForResponse(
            (r) => r.url().endsWith("/api/content-access/grants") && r.request().method() === "PUT",
          );
          await panel.locator('button[type="submit"]').click();
          assert.equal((await conflict).status(), 409);
          assert.equal(await member.isDisabled(), true);
          assert.match(await panel.locator("[data-access-notice]").textContent(), /reload/i);
          await panel.locator("[data-access-reload]").click();
          await page.waitForFunction(() => !document.querySelector("[data-access-fields]").disabled);
          assert.equal(await panel.locator("[data-access-grants] li").count(), 3);
          const current = await json("/api/content-access/grants?project=" + project);
          assert.equal(current.grants.find((g) => g.owner === contentFixtureOwner("alice")).role, "reader");
          await json(
            "/api/content-access/grants",
            { project, owner: contentFixtureOwner("bob"), role: null, revision: current.revision },
            "PUT",
          );
          await panel.locator("[data-access-reload]").click();
          await page.waitForFunction(() => !document.querySelector("[data-access-fields]").disabled);
        }
      } else assert.equal(await panel.locator("[data-access-form]").count(), 0);
      const metrics = await page.evaluate(() => {
        const root = document.querySelector("[data-content-access]"),
          summary = root.querySelector("summary").getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          summary: summary.height,
          fields: [...root.querySelectorAll(".wb-field")].map((label) => {
            const caption = label.querySelector("span").getBoundingClientRect(),
              control = label.querySelector("input,select,code").getBoundingClientRect();
            return { captionBottom: caption.bottom, controlTop: control.top, left: control.left, right: control.right };
          }),
        };
      });
      assert.equal(metrics.overflow, false);
      assert.ok(metrics.summary >= 44);
      for (const field of metrics.fields) {
        assert.ok(field.captionBottom <= field.controlTop + 1);
        assert.ok(field.left >= 0 && field.right <= width);
      }
      await page.screenshot({ path: `${out}/${account}-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  }
  console.log("Project access grant editing, conflict recovery and responsive settings verified.");
} finally {
  await app.close();
}
