import { openConnectedDocumentSources } from "../support/connected-document-sources.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createSiteBuildFixture } from "../support/site-build-fixture.mjs";
import { waitFor } from "../support/app-fixture.mjs";

const fixture = await createSiteBuildFixture(),
  app = fixture.app;
await mkdir(".artifacts/site-publications-browser", { recursive: true });
try {
  for (const [engine, width, locale] of [
    [chromium, 1440, "en"],
    [webkit, 390, "zh-CN"],
  ]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { args: ["--no-sandbox"] } : {}) });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 960 },
        locale,
        colorScheme: width < 700 ? "dark" : "light",
      });
      await app.signIn(context);
      const api = async (path, data, method = "post") => {
        if (path === "/api/projects" && data !== undefined && data.id === undefined)
          return fixture.app.legacyProject(data);
        const response = await context.request[method](app.base + path, { data });
        assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
        return response.json();
      };
      const catalog = await api("/api/projects", undefined, "get");
      const project = (
        await api("/api/projects", {
          code: "publish-" + width,
          name: "Publication workspace",
          revision: catalog.revision,
        })
      ).projects.find((project) => project.code === "publish-" + width);
      const { space } = await api("/api/document-spaces", {
        projectId: project.id,
        code: "site",
        name: "Product handbook",
        engine: "hexo",
        sourceMode: "managed",
        locale: "en",
      });
      await api("/api/documents", {
        spaceId: space.id,
        path: "welcome.md",
        title: "Welcome",
        locale: "en",
        content: "A saved publication fixture.",
      });
      const buildId = randomUUID();
      await api("/api/site-builds", {
        id: buildId,
        spaceId: space.id,
        engine: "hexo",
        title: "Handbook",
        locale: "en",
        url: "https://example.com",
        basePath: "/docs/",
      });
      await waitFor(
        async () => (await api("/api/site-builds/detail?id=" + buildId, undefined, "get")).build.phase === "completed",
      );
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(app.base + "/documents?project=" + project.id);
      await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
      await openConnectedDocumentSources(page);
      await page.locator('[data-doc-action="build"]').click();
      await page.locator('[data-build-action="publish"]').click();
      await page.locator('[data-delivery-action="connections"]').click();
      await page.locator("#publish-name").fill("Documentation site");
      await page.locator("#publish-directory").fill("browser-" + width);
      await page.locator("#publish-url").fill("https://example.com/docs/");
      await page.locator('#publicationConnectionForm [type="submit"]').click();
      await page.locator("[data-connection-test]").waitFor();
      assert.equal(await page.locator("#publish-name").inputValue(), "Documentation site");
      assert.equal(
        (await api("/api/publication-connections?project=" + project.id, undefined, "get")).connections[0].name,
        "Documentation site",
      );
      assert.equal(await page.locator("#publish-directory").isDisabled(), true);
      await page.locator("[data-connection-test]").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#connectionNotice").textContent.includes("No site was published") ||
          document.querySelector("#connectionNotice").textContent.includes("尚未发布站点"),
      );
      const roots = (await api("/api/publication-connections/roots", undefined, "get")).roots;
      const target = join(roots[0].path, "browser-" + width);
      assert.deepEqual(await readdir(target), [".panda-site.json"]);
      await page.locator('[data-delivery-action="history"]').click();
      await page.locator('[data-delivery-action="prepare"]').click();
      await page.locator('.delivery-phase[data-phase="prepared"]').waitFor();
      assert.deepEqual(await readdir(target), [".panda-site.json"]);
      const layout = await page.locator("#sitePublicationDialog").evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        overflow: element.scrollWidth > element.clientWidth + 1,
      }));
      assert.ok(layout.width <= width && layout.height <= 960);
      assert.equal(layout.overflow, false);
      assert.equal(
        /(?:delivery|connections)\.[a-zA-Z]/.test(await page.locator("#sitePublicationDialog").textContent()),
        false,
      );
      await page.screenshot({ path: `.artifacts/site-publications-browser/${width}-plan.png` });
      await page.locator('[data-delivery-action="publish"]').click();
      await page.locator('.delivery-phase[data-phase="published"]').waitFor();
      assert.ok((await readFile(join(target, "current", "index.html"), "utf8")).includes("Fixture website"));
      assert.equal((await readdir(join(target, "releases"))).length, 1);
      await page.screenshot({ path: `.artifacts/site-publications-browser/${width}-receipt.png` });
      await page.locator('[data-delivery-action="close"]').click();
      await page.locator('[data-build-action="close"]').click();
      await page.locator('[data-doc-action="delivery"]').click();
      await page.locator('[data-delivery-action="history"]').click();
      await page.locator('.delivery-phase[data-phase="published"]').waitFor();
      await page.locator('[data-delivery-action="connections"]').click();
      await page.locator("#connectionPicker").selectOption("");
      await page.locator("#publish-name").fill("Remote documentation");
      await page.locator("#publish-connector").selectOption("sftp-site");
      assert.equal(await page.locator("#publish-name").inputValue(), "Remote documentation");
      await page.locator("#publish-host").fill("example.test");
      await page.locator("#publish-username").fill("publisher");
      await page.locator("#publish-hostKey").fill("SHA256:" + Buffer.alloc(32, 1).toString("base64").replace(/=$/, ""));
      await page.locator("#publish-directory").fill("/browser-" + width);
      await page.locator('#publicationConnectionForm [type="submit"]').click();
      await page.locator("#publicationCredentialForm").waitFor();
      assert.equal(await page.locator("[data-connection-test]").isDisabled(), true);
      assert.equal(await page.locator("#publish-host").isDisabled(), true);
      await page.locator("#secret-method").selectOption("password");
      assert.equal(await page.locator("#secret-key").isDisabled(), true);
      await page.locator("#secret-password").fill("browser-disposable-secret");
      await page.locator('#publicationCredentialForm [type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector("[data-connection-test]").disabled);
      assert.equal(await page.locator("#secret-key").inputValue(), "");
      assert.equal(await page.locator("#secret-password").inputValue(), "");
      assert.equal(await page.locator("#publish-host").isDisabled(), true);
      const savedConnections = (await api("/api/publication-connections?project=" + project.id, undefined, "get"))
        .connections;
      assert.equal(savedConnections.find((item) => item.connector === "sftp-site").credentialRevision, 1);
      assert.equal(JSON.stringify(savedConnections).includes("browser-disposable-secret"), false);
      const remoteConnection = savedConnections.find((item) => item.connector === "sftp-site");
      await page.locator("#secret-key").fill("unsaved-private-input");
      await api(
        "/api/publication-connections/detail?id=" + remoteConnection.id,
        {
          version: remoteConnection.version,
          enabled: true,
          name: "Updated remote documentation",
          publicUrl: remoteConnection.publicUrl,
        },
        "put",
      );
      await page.locator("[data-connection-refresh]").click();
      await page.waitForFunction(
        () => document.querySelector("#publish-name").value === "Updated remote documentation",
      );
      assert.equal(await page.locator("#secret-key").inputValue(), "");
      assert.equal(await page.locator("#publish-host").isDisabled(), true);
      await page.locator(".delivery-trust summary").click();
      const replacementPin = "SHA256:" + Buffer.alloc(32, 2).toString("base64").replace(/=$/, "");
      await page.locator("#publish-new-host-key").fill(replacementPin);
      await page.locator('#publicationTrustForm [type="checkbox"]').check();
      await page.locator('#publicationTrustForm [type="submit"]').click();
      await page.waitForFunction((pin) => document.querySelector("#publish-hostKey").value === pin, replacementPin);
      assert.equal(await page.locator("#publish-new-host-key").inputValue(), "");
      const updatedRemote = (
        await api("/api/publication-connections/detail?id=" + remoteConnection.id, undefined, "get")
      ).connection;
      assert.equal(updatedRemote.trustPending, true);
      assert.equal(updatedRemote.credentialRevision, 1);
      assert.equal(updatedRemote.version, remoteConnection.version + 2);
      assert.equal(
        await page.evaluate(() => JSON.stringify(localStorage).includes("browser-disposable-secret")),
        false,
      );
      const overflow = await page
        .locator("#sitePublicationDialog")
        .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
      assert.equal(overflow, false);
      assert.equal(
        /(?:delivery|connections)\.[a-zA-Z]/.test(await page.locator("#sitePublicationDialog").textContent()),
        false,
      );
      await page.screenshot({ path: `.artifacts/site-publications-browser/${width}-sftp.png` });
      assert.deepEqual(errors, []);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  console.log(
    "PC Chromium and H5 WebKit publishing passed: connection test, frozen plan, explicit activation, receipts, reload and i18n.",
  );
} finally {
  await fixture.dispose();
}
