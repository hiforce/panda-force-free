import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { Server, utils } from "ssh2";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_REMOTE_PROOF || ".artifacts/remote-workspace";
await mkdir(out, { recursive: true });
const keyPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "pkcs1" },
  }).privateKey;
const hostKey = keyPair(),
  loginKey = keyPair();
const authorizedKey = utils.parseKey(loginKey);
const fingerprint =
  "SHA256:" + createHash("sha256").update(utils.parseKey(hostKey).getPublicSSH()).digest("base64").replace(/=+$/, "");
const loginPublic = utils.parseKey(loginKey).getPublicSSH();
const channels = new Set(),
  connections = new Set();
let authChecks = 0,
  passwordChecks = 0,
  keyChecks = 0;
const ssh = new Server({ hostKeys: [hostKey] }, (connection) => {
  connections.add(connection);
  connection.on("error", () => {});
  connection.once("close", () => connections.delete(connection));
  connection.on("authentication", (ctx) => {
    authChecks++;
    if (ctx.username !== "operator") return ctx.reject(["password", "publickey"]);
    if (ctx.method === "password") {
      passwordChecks++;
      return ctx.password === "fixture-password" ? ctx.accept() : ctx.reject(["password", "publickey"]);
    }
    if (ctx.method === "publickey" && ctx.key.data.equals(loginPublic)) {
      if (!ctx.signature) return ctx.accept();
      keyChecks++;
      if (authorizedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
    }
    ctx.reject(["password", "publickey"]);
  });
  connection.on("ready", () => {
    connection.on("session", (accept) => {
      const session = accept();
      session.on("pty", (accept) => accept?.());
      session.on("window-change", (accept) => accept?.());
      session.on("shell", (accept) => {
        const stream = accept();
        channels.add(stream);
        stream.once("close", () => channels.delete(stream));
        stream.write("Authorized fixture shell\r\n");
        stream.on("data", (data) => stream.write(data));
      });
    });
  });
});
await new Promise((resolve) => ssh.listen(0, "127.0.0.1", resolve));
const port = ssh.address().port;
const app = await createAppFixture({ startupTimeoutMs: 60000 });
const records = [];
try {
  for (const [engine, width] of [
    [chromium, 1440],
    [webkit, 390],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      await page.goto(app.base + "/tasks");
      const openMenu = async () => {
        if (width < 768 && !(await page.locator("#sidebar").evaluate((el) => el.classList.contains("mobile-open"))))
          await page.locator("#workspaceNavigationToggle").click();
      };
      await openMenu();
      const nav = page.locator(".workspace-tool-navigation");
      const remote = nav.locator('[data-workspace-tool="remote"]');
      await remote.waitFor();
      const border = await page
        .locator(".workbench-primary-navigation")
        .evaluate((el) => getComputedStyle(el).borderBottomWidth);
      assert.equal(border, "1px");
      assert((await remote.boundingBox()).y >= (await page.locator(".workbench-primary-navigation").boundingBox()).y);
      if (width === 1440) {
        await nav.locator("[data-add-tool]").click();
        await page.locator("#workspace-tool-name").fill("Build logs");
        await page.locator("#workspace-tool-url").fill("https://example.test/builds");
        await page.locator(".workspace-tool-dialog [type=submit]").click();
        await page.locator(".workspace-tool-dialog").waitFor({ state: "hidden" });
        await nav.locator('a[href="https://example.test/builds"]').waitFor();
        await page.reload();
        await nav.locator('a[href="https://example.test/builds"]').waitFor();
      }
      await page.locator("#workspacePreparation").waitFor({ state: "hidden", timeout: 60000 });
      await remote.focus();
      assert(await remote.evaluate((el) => document.activeElement === el));
      await page.keyboard.press("Enter");
      await page.waitForURL("**/tools/remote");
      const route = app.base + "/api/remote-connections";
      const dialog = page.locator(".remote-editor");
      const submit = dialog.locator('button[type="submit"]');
      const review = dialog.locator("[data-remote-review]");
      const saved = () =>
        context.request
          .get(route)
          .then((response) => response.json())
          .then(({ items }) => items);
      async function fillRegistration(name, kind) {
        await page.locator("[data-remote-add]").click();
        for (const [input, value] of Object.entries({
          name,
          host: "127.0.0.1",
          port: String(port),
          username: "operator",
        }))
          await dialog.locator(`[name="ssh-${input}"]`).fill(value);
        await dialog.locator('select[name="ssh-method"]').selectOption(kind);
        await dialog.locator(`[name="ssh-${kind}"]`).fill(kind === "password" ? "fixture-password" : loginKey);
      }
      async function readFingerprint(button = submit) {
        const before = authChecks;
        await button.click();
        await review.waitFor();
        assert.equal(await review.locator("[data-remote-key]").textContent(), fingerprint);
        assert.equal(authChecks, before);
      }
      async function saveRegistration(name) {
        await submit.click();
        await dialog.waitFor({ state: "hidden" });
        await page.getByText(name, { exact: true }).waitFor();
      }

      const name = width === 1440 ? "Demo password" : "Demo key";
      const kind = width === 1440 ? "password" : "privateKey";
      await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
      await page.getByRole("heading", { name: "远程", exact: true }).waitFor();
      await fillRegistration(name, kind);
      const submitBox = async () => {
        const { x, width, height } = await submit.boundingBox();
        return [x, width, height].map(Math.round);
      };
      const footerWithinDialog = () =>
        submit.evaluate((button) => {
          const action = button.getBoundingClientRect();
          const panel = button.closest("dialog").getBoundingClientRect();
          const target = document.elementFromPoint(action.left + action.width / 2, action.top + action.height / 2);
          return action.top >= panel.top && action.bottom <= panel.bottom && button.contains(target);
        });
      const normalButton = await submitBox();
      assert(await footerWithinDialog());
      const cancelButton = await dialog.locator("[data-remote-cancel]").boundingBox();
      assert.equal(Math.round(cancelButton.width), normalButton[1]);
      assert(normalButton[2] >= 44);
      const credential = dialog.locator(`[name="ssh-${kind}"]`);
      const fixtureCredential = await credential.inputValue();
      await credential.fill("");
      await page.screenshot({ path: `${out}/register-${width}.png` });
      await credential.fill(fixtureCredential);
      let requested = 0;
      const interceptProbe = async (request) => {
        const { host, port: askedPort, ...extra } = request.request().postDataJSON();
        assert.equal(host, "127.0.0.1");
        assert.equal(askedPort, port);
        assert.deepEqual(extra, {});
        if (++requested > 1) return request.continue();
        await new Promise((resolve) => setTimeout(resolve, 600));
        return request.fulfill({ status: 503, json: { messageId: "remoteTools.hostKeyUnavailable" } });
      };
      await page.route("**/api/remote-connections/host-key", interceptProbe);
      await submit.click();
      await submit.locator(".busy-indicator").waitFor();
      assert.deepEqual(await submitBox(), normalButton);
      await dialog.locator("[role=alert]:visible").waitFor();
      assert.equal(await dialog.locator('[name="ssh-name"]').inputValue(), name);
      assert(!(await saved()).some((item) => item.name === name));
      await readFingerprint();
      assert(!(await saved()).some((item) => item.name === name));
      assert(await review.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
      assert.deepEqual(await submitBox(), normalButton);
      assert(await footerWithinDialog());
      await page.screenshot({ path: `${out}/review-fingerprint-${width}.png` });
      if (width === 1440) await page.keyboard.press("Escape");
      else await dialog.locator("[data-remote-back]").click();
      assert.equal(
        await dialog.locator(`[name="ssh-${kind}"]`).inputValue(),
        kind === "password" ? "fixture-password" : loginKey,
      );
      await readFingerprint();
      await page.unroute("**/api/remote-connections/host-key", interceptProbe);
      if (width === 1440) {
        // A response lost after committing keeps the confirmation and retries the same operation.
        let loseResponse = true;
        await page.route("**/api/remote-connections", async (route) => {
          if (!loseResponse || route.request().method() !== "POST") return route.continue();
          loseResponse = false;
          await new Promise((resolve) => setTimeout(resolve, 600));
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          return route.fulfill({ status: 503, json: { error: "remoteTools.unavailable" } });
        });
        await submit.click();
        await submit.locator(".busy-indicator").waitFor();
        assert.deepEqual(await submitBox(), normalButton);
        await dialog.locator("[role=alert]:visible").waitFor();
        assert(await review.isVisible());
      }
      await saveRegistration(name);
      assert.equal((await saved()).filter((item) => item.name === name).length, 1);
      const oldFingerprint = "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=+$/, "");
      if (width === 1440) {
        const seed = await context.request.post(route, {
          headers: { Origin: app.base },
          data: {
            id: crypto.randomUUID(),
            version: 0,
            operationId: crypto.randomUUID(),
            name: "Invalid fingerprint",
            host: "127.0.0.1",
            port,
            username: "operator",
            hostKey: oldFingerprint,
            credential: { method: "password", password: "fixture-password" },
          },
        });
        assert.equal(seed.status(), 200);
        await page.reload();
        await page.getByText("Invalid fingerprint", { exact: true }).waitFor();
      }
      for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
        const text = JSON.parse(await readFile(`src/shared/i18n/locales/${locale}/remoteTools.json`, "utf8"));
        await page.evaluate((language) => globalThis.__pandaForceI18n.setPreference(language), locale);
        await page.getByRole("heading", { name: text.title, exact: true }).waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await page.screenshot({ path: `${out}/remote-list-${width}.png` });
      await openMenu();
      await page.screenshot({ path: `${out}/remote-sidebar-${width}.png` });
      if (width < 768) await page.locator("#workspaceNavigationToggle").click();
      const openTerminal = async (name) => {
        const row = page.locator(".remote-connection-row").filter({ hasText: name });
        const [popup] = await Promise.all([
          context.waitForEvent("page"),
          row.locator("[data-remote-terminal]").click(),
        ]);
        await popup.locator(".remote-console").waitFor();
        assert(await popup.locator("#app").isHidden());
        assert(await popup.locator("#workspacePreparation").isHidden());
        assert.match(popup.url(), /\/tools\/remote\/terminal\//);
        assert.equal(await popup.evaluate(() => window.opener), null);
        assert.equal(new URL(page.url()).pathname, "/tools/remote");
        return popup;
      };
      const success = await openTerminal(width === 1440 ? "Demo password" : "Demo key");
      await success
        .getByRole("status")
        .filter({ hasText: /已連線/ })
        .waitFor();
      await success.getByText("Authorized fixture shell", { exact: true }).waitFor();
      if (width === 1440) {
        await success.locator(".xterm-helper-textarea").focus();
        await success.keyboard.type("remote-input-proof");
        await success.getByText("remote-input-proof", { exact: true }).waitFor();
      }
      assert(await success.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await success.screenshot({ path: `${out}/remote-console-${width}.png` });
      assert(
        await success
          .locator("[data-remote-address]")
          .textContent()
          .then((value) => value.includes(name)),
      );
      const fontValue = success.locator("[data-remote-font-size]");
      const fontUp = success.locator("[data-remote-font-up]");
      assert((await fontUp.boundingBox()).height >= (width < 768 ? 44 : 40));
      await fontUp.focus();
      await success.keyboard.press("Enter");
      assert.equal(await fontValue.textContent(), "14");
      await success.locator("[data-remote-font-down]").click();
      assert.equal(await fontValue.textContent(), "13");
      await fontUp.click();
      await fontValue.click();
      assert.equal(await fontValue.textContent(), "13");
      const reconnect = success.locator("[data-remote-reconnect]");
      const attempts = authChecks;
      await reconnect.click();
      await success
        .getByRole("status")
        .filter({ hasText: /已連線/ })
        .waitFor();
      assert(authChecks > attempts);
      await success.getByText("Authorized fixture shell", { exact: true }).last().waitFor();
      for (const channel of channels) channel.close();
      await success.locator('.remote-console-status[data-state="disconnected"]').waitFor();
      await reconnect.click();
      await success.locator('.remote-console-status[data-state="connected"]').waitFor();
      await success
        .locator("[data-remote-close]")
        .click()
        .catch((error) => {
          if (!success.isClosed()) throw error;
        });
      await waitFor(() => success.isClosed() || new URL(success.url()).pathname === "/tools/remote");
      if (!success.isClosed()) await success.close();
      if (width === 1440) {
        const authBefore = authChecks;
        const reject = await openTerminal("Invalid fingerprint");
        await reject
          .getByRole("alert")
          .filter({ hasText: /指紋.*不符/ })
          .waitFor();
        assert.equal(authChecks, authBefore);
        await reject.close();
        await page
          .locator(".remote-connection-row")
          .filter({ hasText: "Invalid fingerprint" })
          .locator("[data-remote-edit]")
          .click();
        await dialog.locator("[data-remote-saved-host] summary").click();
        await readFingerprint(dialog.locator("[data-remote-recheck]"));
        assert(await review.locator("[data-remote-previous]").isVisible());
        assert.equal(await review.locator("[data-remote-previous] code").textContent(), oldFingerprint);
        await submit.click();
        await dialog.locator("[role=alert]:visible").waitFor();
        assert.equal((await saved()).find((item) => item.name === "Invalid fingerprint").hostKey, oldFingerprint);
        await dialog.locator('[name="ssh-password"]').fill("fixture-password");
        await saveRegistration("Invalid fingerprint");
        assert.equal((await saved()).find((item) => item.name === "Invalid fingerprint").hostKey, fingerprint);
        const rotated = await openTerminal("Invalid fingerprint");
        await rotated
          .getByRole("status")
          .filter({ hasText: /已連線/ })
          .waitFor();
        await rotated.close();
        const invalidProbe = await context.request.post(route + "/host-key", {
          headers: { Origin: app.base },
          data: { host: "127.0.0.1", port, password: "fixture-password" },
        });
        assert.equal(invalidProbe.status(), 400);
        const forbiddenProbe = await context.request.post(route + "/host-key", {
          headers: { Origin: "https://other.test" },
          data: { host: "127.0.0.1", port },
        });
        assert([401, 403].includes(forbiddenProbe.status()));

        const forbidden = await context.request.post(app.base + "/api/remote-connections", {
          headers: { Origin: "https://other.test" },
          data: {},
        });
        assert([401, 403].includes(forbidden.status()));
        const list = await context.request.get(app.base + "/api/remote-connections");
        const body = await list.text();
        assert(!body.includes("fixture-password") && !body.includes("PRIVATE KEY") && !body.includes("ciphertext"));
        const { items } = JSON.parse(body);
        assert.equal(items.filter((item) => item.name === "Demo password").length, 1);
      }
      assert.deepEqual(errors, []);
      records.push({
        width,
        locales: 4,
        independentTab: true,
        ssh: true,
        reconnected: true,
        reviewedFingerprint: true,
        stableActions: true,
        terminalControls: true,
      });
      await context.close();
      await waitFor(() => channels.size === 0);
    } finally {
      await browser.close();
    }
  }
  assert(passwordChecks > 0 && keyChecks > 0);
  assert.equal((await fetch(app.base + "/api/remote-connections")).status, 401);
  assert.equal((await fetch(app.base + "/api/remote-connections/host-key", { method: "POST" })).status, 401);
  await writeFile(`${out}/result.json`, JSON.stringify({ passed: true, records, password: true, key: true }, null, 2));
} finally {
  await app.dispose();
  for (const connection of connections) connection.end();
  ssh.close();
}
