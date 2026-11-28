import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { unlockEncryptionKey } from "../../src/client/encryption-keys/key-store.ts";
import { memoryPackageRecipient, sealMemoryPackage } from "../../src/server/project-memory/pmf.ts";
import { pmfHeaderBytes, pmfTagBytes } from "../../src/shared/project-memory/pmf-envelope.ts";
import { memoryPackageMediaType } from "../../src/shared/project-memory/archive.ts";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { chromium, webkit } from "playwright";
import { unzipSync, zipSync } from "fflate";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const output = process.env.PANDA_FORCE_MEMORY_PROOF || ".artifacts/project-memory";
await mkdir(output, { recursive: true });
const app = await createAppFixture({
  startupTimeoutMs: 60000,
  completedTurnNotifications: true,
  extraEnvironment({ dir }) {
    const accountHome = join(dir, "grok-account");
    mkdirSync(accountHome, { recursive: true });
    writeFileSync(join(accountHome, "auth.json"), JSON.stringify({ fixture: { access_token: "fixture-only" } }));
    return {
      PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
        {
          id: "grok-local",
          name: "Grok Local",
          command: resolve("tests/support/grok-acp-fixture.mjs"),
          accountHome,
        },
      ]),
    };
  },
});
try {
  for (const [engine, width, locale] of [
    [chromium, 1366, "en"],
    [webkit, 390, "zh-CN"],
    [webkit, 390, "zh-HK"],
    [webkit, 320, "zh-TW"],
  ]) {
    const browser = await engine.launch();
    let page;
    try {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
      });
      await app.signIn(context);
      await context.addInitScript((language) => {
        if (window === window.top) {
          localStorage.setItem("panda-force-locale", language);
          localStorage.setItem("panda-force-theme", language === "en" || language === "zh-TW" ? "aurora" : "light");
        }
      }, locale);
      const api = async (path, method = "GET", data) => {
        const response = await context.request.fetch(app.base + path, { method, data, headers: { Origin: app.base } });
        assert(response.ok(), path + " " + response.status() + " " + (await response.text()));
        return response.json();
      };
      const catalog = await api("/api/projects");
      const code = "memory-fixture-" + locale.toLowerCase();
      const project = (
        await api("/api/projects", "POST", {
          name: "Memory project " + locale,
          code,
          revision: catalog.revision,
          operationId: crypto.randomUUID(),
        })
      ).projects.find((entry) => entry.code === code);
      assert(project);
      page = await context.newPage();
      page.on("pageerror", (error) => console.error(locale, error.message));
      page.on("response", (response) => {
        if (response.url().includes("/memory") && !response.ok())
          console.error(locale, response.status(), response.url());
      });
      const route = "/project?id=" + encodeURIComponent(project.id) + "&tab=memory";
      await page.goto(app.base + route);
      const panel = page.locator(".project-memory-view");
      const mode = (id) => panel.locator(`[data-memory-mode="${id}"]`);
      await panel.locator(".memory-terrain-state").waitFor();
      const toolbar = panel.locator(".memory-toolbar");
      const toolbarButtons = toolbar.locator("button");
      assert.equal(await toolbarButtons.count(), 5);
      assert.equal(await toolbar.locator("svg").count(), 5);
      await toolbar
        .locator(".memory-toolbar-label")
        .first()
        .waitFor({ state: width >= 768 ? "visible" : "hidden" });
      const targets = await toolbarButtons.evaluateAll((buttons) =>
        buttons.map((button) => ({
          ...button.getBoundingClientRect().toJSON(),
          label: button.getAttribute("aria-label"),
        })),
      );
      assert(targets.every(({ y, label }) => y === targets[0].y && label));
      if (width < 768) assert(targets.every(({ width, height }) => width >= 44 && height >= 44));
      const settingsToggle = panel.locator('[data-memory-panel="policy"]');
      await settingsToggle.press("Enter");
      assert.equal(await settingsToggle.getAttribute("aria-expanded"), "true");
      await panel.locator("[data-memory-write]").press("Escape");
      assert.equal(await settingsToggle.getAttribute("aria-expanded"), "false");
      assert(await settingsToggle.evaluate((button) => document.activeElement === button));
      await mode("records").click();
      await panel
        .locator("[data-memory-entries] > p")
        .waitFor({ timeout: 12000 })
        .catch(async (error) => {
          console.error(locale, (await page.locator("body").innerText()).slice(-2200));
          throw error;
        });
      await panel.locator('[data-memory-panel="policy"]').click();
      assert.equal(await panel.locator("[data-memory-write]").isChecked(), false);
      assert.equal(await panel.locator("[data-memory-recall]").isChecked(), false);
      await panel.locator("[data-memory-write]").check();
      await panel.locator("[data-memory-recall]").check();
      await panel.locator("[data-memory-save]").click();
      await waitFor(async () => (await api("/api/projects/" + project.id + "/memory-policy")).recall);
      const sessions = "/api/personal/harness/conversations";
      const unbound = await api(sessions, "POST", {});
      const unboundPath = sessions + "/" + unbound.conversation.id;
      for (const endpoint of ["memory", "memory-policy"]) {
        const denied = await context.request.get(app.base + unboundPath + "/" + endpoint);
        assert.equal(denied.status(), 404);
      }
      await api(unboundPath + "/runs", "POST", {
        requestId: crypto.randomUUID(),
        text: "Project convention [release]: pre-link example = excluded",
      });
      await waitFor(async () => !(await api(unboundPath)).conversation.activeRunId);
      const forBinding = await api("/api/projects");
      await api("/api/projects/assign", "POST", {
        projectId: project.id,
        sessionIds: ["harness:" + unbound.conversation.id],
        revision: forBinding.revision,
      });
      assert.deepEqual((await api(unboundPath + "/memory")).contributions.entries, []);
      const opened = await api(sessions, "POST", { projectId: project.id });
      const source = sessions + "/" + opened.conversation.id;
      await api(source + "/runs", "POST", {
        requestId: crypto.randomUUID(),
        text: "Project convention [release]: cache ttl = 24 hours",
      });
      await waitFor(async () => (await api("/api/projects/" + project.id + "/memory")).entries.length === 1);
      {
        const passphrase = "test fixture phrase for PMF keys";
        await page.goto(app.base + "/settings/encryption-keys");
        const keyForm = page.locator("[data-key-create]");
        await page.locator("[data-open-key-create]").click();
        await keyForm.locator('[name="keyName"]').fill("PMF fixture " + locale);
        await keyForm.locator('[name="password"]').fill(passphrase);
        await keyForm.locator('[name="repeat"]').fill(passphrase);
        const backingUp = page.waitForEvent("download");
        await keyForm.locator('button[type="submit"]').click();
        const backupDownload = await backingUp;
        assert.match(backupDownload.suggestedFilename(), /\.pfkey$/);
        const backupFile = join(app.dir, backupDownload.suggestedFilename());
        await backupDownload.saveAs(backupFile);
        const backup = await Bun.file(backupFile).json();
        await page.locator("[data-key-backup]").waitFor();
        await page.screenshot({ path: join(output, "memory-key-settings-" + locale + ".png"), fullPage: true });
        await page.goto(app.base + route + "&memoryView=records");
        const packages = page.locator(".memory-package-dialog");
        const manage = panel.locator("[data-memory-packages-import]");
        const exportEntry = panel.locator("[data-memory-packages-export]");
        await manage.waitFor();
        assert.equal(await manage.locator(".memory-toolbar-label").isVisible(), width >= 760);
        assert.equal(await exportEntry.locator(".memory-toolbar-label").isVisible(), width >= 760);
        assert(await manage.boundingBox());
        assert((await manage.boundingBox()).y === (await exportEntry.boundingBox()).y);
        await exportEntry.click();
        await packages.waitFor({ state: "visible" });
        assert.equal(await packages.locator("[data-memory-package-file]").count(), 0);
        await page.screenshot({ path: join(output, "memory-package-export-" + locale + ".png"), fullPage: true });
        if (locale === "en") {
          const endpoint = /\/memory-export$/u;
          const button = packages.locator("[data-memory-package-export]");
          const fakeExport = (route) =>
            route.fulfill({
              status: 200,
              contentType: memoryPackageMediaType,
              body: Buffer.from(zipSync({ "manifest.json": Buffer.alloc(600) }, { level: 0 })),
            });
          await page.route(endpoint, fakeExport);
          try {
            await button.click();
            await packages.getByText("The downloaded memory package was invalid. Try again.").waitFor();
            assert.equal(await button.isEnabled(), true);
          } finally {
            await page.unroute(endpoint, fakeExport);
          }
        }
        const downloading = page.waitForEvent("download");
        await packages.locator("[data-memory-package-export]").click();
        const download = await downloading;
        assert.match(download.suggestedFilename(), /\.pmf$/);
        const exportFile = join(app.dir, download.suggestedFilename());
        await download.saveAs(exportFile);
        const pmf = Buffer.from(await Bun.file(exportFile).arrayBuffer());
        assert.equal(pmf.subarray(0, 4).toString("hex"), "504d4601");
        assert(!pmf.includes(Buffer.from("24 hours")));
        const privateKey = await unlockEncryptionKey(backup, passphrase);
        const content = Buffer.from(
          await crypto.subtle.decrypt("RSA-OAEP", privateKey, Uint8Array.from(pmf.subarray(36, 420))),
        );
        const open = createDecipheriv("aes-256-gcm", content, pmf.subarray(pmfHeaderBytes - 12, pmfHeaderBytes));
        open.setAAD(pmf.subarray(0, pmfHeaderBytes));
        open.setAuthTag(pmf.subarray(-pmfTagBytes));
        const files = unzipSync(Buffer.concat([open.update(pmf.subarray(pmfHeaderBytes, -pmfTagBytes)), open.final()]));
        assert.deepEqual(Object.keys(files), ["manifest.json"]);
        const archive = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
        assert.equal(archive.format, "panda-project-knowledge");
        assert.equal(archive.records[0].values[0], "24 hours");
        assert(!JSON.stringify(archive).includes(opened.conversation.id));
        await packages.locator("[data-memory-package-close]").click();
        assert(await exportEntry.evaluate((button) => button === document.activeElement));
        const current = await api("/api/projects");
        const restoreCode = "memory-restore-" + locale.toLowerCase();
        const restore = (
          await api("/api/projects", "POST", {
            name: "Restored project " + locale,
            code: restoreCode,
            revision: current.revision,
            operationId: crypto.randomUUID(),
          })
        ).projects.find((entry) => entry.code === restoreCode);
        assert(restore);
        const restoreRoute =
          "/project?" + new URLSearchParams({ id: restore.id, tab: "memory", memoryView: "records" });
        if (locale === "en" || locale === "zh-TW") {
          await page.evaluate(() =>
            localStorage.removeItem("pf-encryption-keys:" + globalThis.__pandaForceIdentityKey),
          );
          await page.goto(app.base + "/settings/encryption-keys");
          const restoreKey = page.locator("[data-key-restore]");
          await page.locator("[data-open-key-restore]").click();
          await restoreKey.locator("[name=backup]").setInputFiles(backupFile);
          await restoreKey.locator("[name=password]").fill(passphrase);
          await restoreKey.locator('button[type="submit"]').click();
          await page.locator("[data-key-backup]").waitFor();
        }
        await page.goto(app.base + restoreRoute);
        await manage.click();
        const choose = packages.locator("[data-memory-package-file]");
        const preview = packages.locator("[data-memory-package-review]");
        const insert = packages.locator('button[type="submit"]');
        const status = packages.locator("[data-memory-package-status]");
        const picker = packages.locator("[data-memory-package-choose]");
        const unlock = packages.locator("[data-memory-package-unlock] input");
        assert.equal(await packages.locator("[data-memory-package-export]").count(), 0);
        assert.equal(await preview.isVisible(), false);
        await page.screenshot({ path: join(output, "memory-package-picker-" + locale + ".png"), fullPage: true });
        assert.equal(await choose.getAttribute("accept"), ".pmf");
        assert.equal(await choose.isVisible(), false);
        const fileChooser = page.waitForEvent("filechooser");
        await picker.focus();
        await picker.press("Enter");
        await (
          await fileChooser
        ).setFiles({ name: "legacy.json", mimeType: "application/json", buffer: Buffer.from("{}") });
        assert(await preview.isDisabled());
        assert.match(await status.textContent(), /\.pmf/);
        if (locale === "en") {
          const prefix = "/api/projects/" + restore.id + "/";
          const withoutRecipient = await context.request.post(app.base + prefix + "memory-export", {
            data: {},
            headers: { Origin: app.base },
          });
          assert.equal(withoutRecipient.status(), 400);
          const legacy = await context.request.post(app.base + prefix + "memory-import-preview", {
            data: { archive },
            headers: { Origin: app.base },
          });
          assert.equal(legacy.status(), 400);
          const legacyStart = await context.request.post(app.base + prefix + "memory-upload", {
            data: { name: "legacy.json", size: 256 },
            headers: { Origin: app.base },
          });
          assert.equal(legacyStart.status(), 400);

          const chunks = [];
          const hold = Promise.withResolvers();
          const pause = Promise.withResolvers();
          const uploads = /\/memory-upload\?upload=.*&offset=/;
          await page.route(uploads, async (route) => {
            const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
            chunks.push(offset);
            if (chunks.length === 2) {
              pause.resolve();
              await hold.promise;
              await route.abort().catch(() => {});
            } else await route.continue();
          });
          const zip = zipSync(
            {
              "manifest.json": files["manifest.json"],
              "assets/presentation.pptx": new Uint8Array(2 * 1024 * 1024 + 100),
            },
            { level: 0 },
          );
          const large = sealMemoryPackage(memoryPackageRecipient(backup.publicKey), zip);
          await choose.setInputFiles({ name: "large.pmf", mimeType: "application/octet-stream", buffer: large });
          await unlock.fill(passphrase);
          await preview.click();
          await pause.promise;
          const progress = packages.locator("progress");
          await progress.waitFor({ state: "visible" });
          const percent = await progress.evaluate((element) => element.value);
          assert(percent > 0 && percent < 100);
          await page.screenshot({ path: join(output, "memory-package-progress-en.png"), fullPage: true });
          await packages.locator("[data-memory-package-stop]").click();
          await waitFor(async () => (await status.textContent()).includes("paused"));
          hold.resolve();
          await preview.click();
          await waitFor(async () => (await status.textContent()).includes("without attachments"));
          assert.deepEqual(chunks, [0, 1_048_576, 1_048_576, 2_097_152]);
          assert(await insert.isDisabled());
          await page.unroute(uploads);
        }
        await choose.setInputFiles(exportFile);
        if (locale === "en") {
          await unlock.fill("wrong fixture passphrase");
          await preview.click();
          await waitFor(async () => (await status.textContent()).includes("could not be unlocked"));
          assert(await insert.isDisabled());
        }
        await unlock.fill(passphrase);
        await preview.click();
        await packages.locator(".memory-package-preview-list").getByText("24 hours", { exact: true }).waitFor();
        assert.equal(await preview.isVisible(), false);
        assert(await insert.isEnabled());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert(await packages.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1));
        await page.screenshot({ path: join(output, "memory-package-" + locale + ".png"), fullPage: true });
        await insert.click();
        const revive = packages.locator("[data-package-withdraw]");
        await revive.waitFor();
        await packages.locator("[data-memory-package-close]").click();
        assert(await manage.evaluate((button) => button === document.activeElement));
        await panel.locator(".project-memory-entry").getByText("24 hours", { exact: true }).waitFor();
        await manage.click();
        await choose.setInputFiles(exportFile);
        await unlock.fill(passphrase);
        await preview.click();
        await packages.locator(".memory-package-preview-list").getByText("24 hours", { exact: true }).waitFor();
        assert(await insert.isDisabled());
        await packages.locator("summary").click();
        await revive.click();
        const confirmation = page.getByRole("alertdialog");
        await confirmation.locator("button.danger").click();
        await revive.waitFor({ state: "detached" });
        await packages.locator("[data-memory-package-close]").click();
        await waitFor(async () => (await api("/api/projects/" + restore.id + "/memory")).entries.length === 0);
        await page.goto(app.base + route);
      }
      const terrainApi = "/api/projects/" + project.id + "/memory-terrain";
      const initialTerrain = await api(terrainApi);
      assert.equal(initialTerrain.places[0].entry.scope, "release");
      const extra = await api(sessions, "POST", { projectId: project.id });
      const extraPath = sessions + "/" + extra.conversation.id;
      const extraClaims = [
        "Project convention [integration]: cache ttl = 7 days",
        "Project convention [local]: cache ttl = 2 hours",
        "Project convention [release]: build command = bun run verify",
      ];
      if (locale === "en")
        for (const scope of ["staging", "canary", "preflight", "archive"])
          extraClaims.push(`Project convention [${scope}]: cache ttl = 2 days`);
      await api(extraPath + "/runs", "POST", { requestId: crypto.randomUUID(), text: extraClaims.join("\n") });
      const twoThemes = await waitFor(async () => {
        const data = await api(terrainApi);
        return data.topics.length === 2 && data;
      });
      const cache = twoThemes.topics.find(({ name }) => name === "cache-ttl");
      const build = twoThemes.topics.find(({ name }) => name === "build-command");
      const cacheView = await api(terrainApi + "?topic=" + cache.id);
      assert.equal(cacheView.plate, initialTerrain.plate);
      assert.equal(cacheView.places[0].slot, initialTerrain.places[0].slot);
      const nextPlate = cacheView.plates[1]
        ? await api(terrainApi + "?topic=" + cache.id + "&plate=" + cacheView.plates[1])
        : null;
      if (locale === "en") {
        assert.equal(cacheView.places.length, 6);
        assert.equal(nextPlate?.places.length, 1);
        assert.equal(nextPlate.places[0].slot, 0);
      }

      await page.goto(app.base + route);
      const map = panel.locator(".memory-terrain-scene");
      await map.waitFor();
      assert.equal(await panel.locator("[data-memory-topic]:visible").count(), 0);
      const release = initialTerrain.places[0].entry.id;
      const marker = (id) => map.locator(`[data-memory-place="${id}"]`);
      await marker(release).press("Enter");
      const detail = panel.locator("[data-memory-place-detail]");
      await detail.getByText("24 hours", { exact: true }).waitFor();
      const mapImage = () => map.locator("canvas").evaluate((canvas) => canvas.toDataURL());
      const fingerprint = await mapImage();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert((await marker(release).boundingBox()).height >= 44);
      await page.screenshot({ path: join(output, "terrain-" + locale + ".png"), fullPage: true });
      await panel.locator('[data-place-action="practice"]').click();
      assert.equal(await detail.locator("code, [data-memory-source-message]").count(), 0);
      await panel.locator('[data-place-action="reveal"]').click();
      await detail.getByText("24 hours", { exact: true }).waitFor();
      await panel.locator('[data-place-action="next"]').click();
      assert.equal(await detail.locator("code, [data-memory-source-message]").count(), 0);
      const buildEntry = (await api(terrainApi + "?topic=" + build.id)).places[0].entry;
      await page.goto(app.base + route + "&place=" + buildEntry.id);
      await detail.getByText("bun run verify", { exact: true }).waitFor();
      await page.goto(app.base + route + "&place=" + release);
      await detail.getByText("24 hours", { exact: true }).waitFor();
      await waitFor(async () => (await mapImage()) === fingerprint);
      await mode("evidence").click();
      const sourceEvidence = detail.locator("[data-memory-source-message]");
      await sourceEvidence.locator("summary").click();
      await sourceEvidence
        .locator("[data-memory-source-content]")
        .getByText("Project convention [release]: cache ttl = 24 hours", { exact: true })
        .waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(output, "evidence-" + locale + ".png"), fullPage: true });
      const original = page.locator("[data-memory-original]");
      const evidenceLink = sourceEvidence.locator("a[href*='memoryMessage=']");
      const sourceHref = await evidenceLink.getAttribute("href");
      assert(sourceHref.includes("memoryView=evidence"));
      await evidenceLink.press("Enter");
      await original
        .locator(".memory-source-body")
        .getByText("Project convention [release]: cache ttl = 24 hours", { exact: true })
        .waitFor();
      assert.equal(
        await original.getAttribute("data-memory-message-id"),
        initialTerrain.places[0].entry.sources[0].messageId,
      );
      assert(await original.evaluate((article) => article === document.activeElement));
      assert(await page.locator("#prompt").isHidden());
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(output, "memory-source-" + locale + ".png"), fullPage: true });
      await page.goBack();
      await detail.getByText("24 hours", { exact: true }).waitFor();
      assert.equal(await mode("evidence").getAttribute("aria-pressed"), "true");
      await page.goForward();
      await original.waitFor({ state: "visible" });
      await page.locator(".memory-source-back").click();
      await detail.getByText("24 hours", { exact: true }).waitFor();
      assert.equal(await mode("evidence").getAttribute("aria-pressed"), "true");
      const extraEvidence = [...cacheView.places, ...(nextPlate?.places ?? [])].find(
        ({ entry }) => entry.scope === "local",
      ).entry.sources[0];
      const extraSource =
        "/api/projects/" +
        project.id +
        "/memory-source?" +
        new URLSearchParams({
          conversation: extraEvidence.conversationId,
          message: extraEvidence.messageId,
        });
      assert((await api(extraSource)).text.includes(extraClaims[1]));
      const extraPolicy = await api(extraPath + "/memory-policy");
      await api(extraPath + "/memory-policy", "PATCH", {
        revision: extraPolicy.source.revision,
        write: null,
        recall: null,
        revoke: true,
      });
      assert.equal((await context.request.get(app.base + extraSource)).status(), 404);
      if (locale === "en") {
        const withdrawnPath =
          "/task/" +
          encodeURIComponent("harness:" + extraEvidence.conversationId) +
          "?" +
          new URLSearchParams({ project: project.id, memoryMessage: extraEvidence.messageId, memoryView: "evidence" });
        await page.goto(app.base + withdrawnPath);
        await page
          .locator("[data-memory-source-reader-status]")
          .getByText("This source message is unavailable.", { exact: true })
          .waitFor();
        assert(await original.isHidden());
        assert(await page.locator("[data-memory-source-open]").isHidden());
        await page.locator(".memory-source-back").click();
        await mode("evidence").waitFor();
      }
      const afterWithdrawal = await api(terrainApi + "?topic=" + cache.id);
      assert.deepEqual(afterWithdrawal.plates, initialTerrain.plates);
      assert.deepEqual(afterWithdrawal.places, initialTerrain.places);
      assert.deepEqual(afterWithdrawal.topics, initialTerrain.topics);
      await mode("terrain").click();
      await marker(release).waitFor();
      assert.equal(await map.locator("[data-memory-place]").count(), 1);
      await mode("records").click();
      const entry = panel.locator(".project-memory-entry");
      await entry.getByText("24 hours").waitFor();
      const memoryApi = "/api/projects/" + project.id + "/memory";
      await waitFor(async () => (await api(memoryApi + "?q=cache%20ttl")).entries.length === 1);
      if (locale === "en") {
        const target = await api(sessions, "POST", { projectId: project.id });
        const targetPath = sessions + "/" + target.conversation.id;
        const question = "What is the release cache ttl?";
        const ask = async () => {
          await api(targetPath + "/runs", "POST", { requestId: crypto.randomUUID(), text: question });
          await waitFor(async () => !(await api(targetPath)).conversation.activeRunId);
        };
        await ask();
        assert.equal((await api(targetPath + "/memory")).recalls[0].status, "sent");
        const db = new Database(join(app.dir, "panda-state/data/harness.sqlite"), { readonly: true });
        try {
          const row = db
            .query(
              "SELECT data FROM harness_records WHERE kind='memory-index:local' AND json_extract(data,'$.project')=?",
            )
            .get(project.id);
          const generation = JSON.parse(row.data).published.name;
          writeFileSync(join(app.dir, "panda-state/harness/memory-index", generation + ".json"), "{}");
        } finally {
          db.close();
        }
        await ask();
        const fallback = await api(targetPath + "/memory");
        assert(fallback.recalls.some(({ status }) => status === "indexUnavailable"));
        await waitFor(async () => (await api(memoryApi + "?q=cache%20ttl")).entries.length === 1);
      }
      const search = panel.locator("[data-memory-search] input");
      await search.fill("no-match-for-this-word");
      await search.press("Enter");
      await panel.locator("[data-memory-entries] > p").waitFor();
      assert.equal(await entry.count(), 0);
      await search.fill("cache ttl");
      await search.press("Enter");
      await entry.getByText("24 hours").waitFor();
      assert(await search.evaluate((node) => document.activeElement === node));
      await page.screenshot({ path: join(output, "project-memory-search-" + locale + ".png"), fullPage: true });
      await search.fill("");
      const pending = panel.locator("[data-memory-index]");
      assert(await pending.isVisible());
      if (locale === "en" || locale === "zh-TW") {
        await pending.locator("summary").click();
        await pending.locator("[data-memory-index-rebuild]").click();
        await waitFor(async () => (await api(memoryApi)).index.state === "ready");
        await pending.locator("[data-memory-index-refresh]").click();
        await entry.getByText("24 hours").waitFor();
        await pending.locator("summary").click();
      }
      const versionHistory = entry.locator("[data-memory-history]");
      await versionHistory.locator("summary").click();
      await versionHistory.locator("li.project-memory-version").getByText("24 hours").waitFor();
      await entry.locator("summary").first().click();
      assert((await entry.locator("a").first().getAttribute("href")).includes(opened.conversation.id));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(output, "project-memory-" + locale + ".png"), fullPage: true });
      await entry.locator("a").first().click();
      await original.waitFor({ state: "visible" });
      await page.locator("[data-memory-source-open]").click();
      await page
        .locator(".user-message")
        .getByText("Project convention [release]: cache ttl = 24 hours", { exact: true })
        .waitFor();
      const sessionActions = page.locator("#sessionActionsButton");
      const localized = (key) => page.evaluate((key) => globalThis[Symbol.for("PandaForce.browserI18n")].t(key), key);
      for (const [action, key] of [
        ["memory-details", "sessions.memoryView"],
        ["memory-settings", "sessions.memorySettings"],
      ]) {
        await sessionActions.click();
        const button = page.locator(`#sessionMemoryActions [data-session-action="${action}"]`);
        await button.click();
        const popup = page.getByRole("dialog", { name: await localized(key), exact: true });
        await popup.waitFor();
        if (action === "memory-details") await popup.getByText("24 hours").waitFor();
        else {
          assert.equal(await popup.locator('[data-memory-field="write"]').inputValue(), "");
          assert.equal(await popup.locator('[data-memory-field="recall"]').inputValue(), "");
        }
        await page.screenshot({ path: join(output, action + "-" + locale + ".png"), fullPage: true });
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "hidden" });
        if (await page.locator("#sessionActionsDialog").isVisible()) await page.keyboard.press("Escape");
        await page.locator("#sessionActionsDialog").waitFor({ state: "hidden" });
      }
      const sessionsRoute = "/project?id=" + encodeURIComponent(project.id) + "&tab=sessions";
      await page.goto(app.base + sessionsRoute);
      const option = page.locator(`[data-wb="session-options"][data-id="harness:${opened.conversation.id}"]`);
      await page.waitForFunction((language) => document.documentElement.lang === language, locale);
      await option.waitFor();
      const title = await localized("sessions.deleteSession");
      const openDelete = async () => {
        await option.click();
        await page.locator(".sidebar-project-menu").getByRole("menuitem", { name: title, exact: true }).click();
        const dialog = page.locator("dialog.confirmation-dialog[open]");
        await dialog.locator(".confirmation-detail").waitFor();
        assert((await dialog.locator(".confirmation-detail").innerText()).includes("1"));
        return dialog;
      };
      await openDelete();
      await page.keyboard.press("Escape");
      assert(await option.isVisible());
      assert.equal((await api(source + "/memory-removal-impact")).stops, 1);
      const dialog = await openDelete();
      await page.screenshot({ path: join(output, "project-memory-impact-" + locale + ".png"), fullPage: true });
      await dialog.getByRole("button", { name: title, exact: true }).click();
      await option.waitFor({ state: "detached" });
      await page.goto(app.base + route);
      await mode("records").click();
      await panel.locator("[data-memory-entries] > p").waitFor();
      assert.equal(await entry.count(), 0);
      assert.deepEqual((await api(memoryApi + "?q=cache%20ttl")).entries, []);
      await panel.locator('[data-memory-panel="policy"]').click();
      const enabled = panel.locator("[data-memory-model-enable]");
      assert.equal(await enabled.isChecked(), false);
      await enabled.check();
      const runtime = panel.locator('[name="project-memory-runtime"]');
      const model = panel.locator('[name="project-memory-model"]');
      await runtime.selectOption("grok-local");
      await model.selectOption("grok-fixture");
      const effort = panel.locator("[data-runtime-effort-slider] input[type=range]");
      await effort.press("Home");
      await effort.press("ArrowRight");
      assert.equal(await panel.locator('[name="project-memory-effort"]').inputValue(), "low");
      await page.screenshot({ path: join(output, "model-settings-" + locale + ".png"), fullPage: true });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await panel.locator("[data-memory-save]").click();
      const policyRoute = "/api/projects/" + project.id + "/memory-policy";
      await waitFor(async () => (await api(policyRoute)).model.enabled);
      const selected = { runtimeId: "grok-local", model: "grok-fixture", effort: "low" };
      assert.deepEqual((await api(policyRoute)).model.selection, selected);
      if (locale === "en" || locale === "zh-TW") {
        const sample = await api(sessions, "POST", { projectId: project.id, runtimeId: "grok-local" });
        const samplePath = sessions + "/" + sample.conversation.id;
        const observations = [
          "Keep the release cache for exactly one day.",
          "Malformed model response should never become memory.",
        ];
        for (const text of observations) {
          await api(samplePath + "/runs", "POST", { requestId: crypto.randomUUID(), text });
          await waitFor(async () => !(await api(samplePath)).conversation.activeRunId);
        }
        // Simulate the idle period without waiting two minutes on each browser.
        const db = new Database(join(app.dir, "panda-state/data/harness.sqlite"));
        try {
          const queued = db
            .query(
              "SELECT count(*) AS count FROM harness_records WHERE kind='project-memory-model-job' AND json_extract(data,'$.conversationId')=?",
            )
            .get(sample.conversation.id).count;
          assert.equal(queued, 2);
          db.query(
            "UPDATE harness_records SET updatedAt=? WHERE kind='project-memory-model-job' AND json_extract(data,'$.conversationId')=?",
          ).run(Date.now() - 100, sample.conversation.id);
        } finally {
          db.close();
        }
        const reviewRoute = "/api/projects/" + project.id + "/memory-model-review";
        await waitFor(async () => (await api(reviewRoute)).reviews.length === 2, 30000);
        const { reviews } = await api(reviewRoute);
        const candidate = reviews.find((review) => review.status === "candidates");
        assert.equal(candidate.candidates[0].quote, observations[0]);
        assert.equal(candidate.tokens, 111);
        assert(reviews.some((review) => review.status === "unverified"));
        assert.deepEqual((await api("/api/projects/" + project.id + "/memory")).entries, []);
        await panel.locator('[data-memory-panel="policy"]').click();
        await panel.locator('[data-memory-panel="review"]').click();
        await panel.locator("[data-memory-review-results]").getByText(observations[0]).waitFor();
        await page.screenshot({ path: join(output, "model-review-" + locale + ".png"), fullPage: true });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await api(samplePath, "DELETE");
        await panel.locator("[data-memory-review-refresh]").click();
        await waitFor(async () => !(await api(reviewRoute)).reviews.length);
        await panel.locator("[data-memory-review-results]").getByText(observations[0]).waitFor({ state: "detached" });
        await panel.locator('[data-memory-panel="policy"]').click();
      }
      await enabled.uncheck();
      assert(await panel.locator("[data-memory-model-fields]").isHidden());
      await panel.locator("[data-memory-save]").click();
      await waitFor(async () => !(await api(policyRoute)).model.enabled);
      assert.deepEqual((await api(policyRoute)).model.selection, selected);
    } catch (error) {
      if (page) {
        await page.screenshot({ path: join(output, "failure-" + locale + ".png"), fullPage: true });
        console.error(locale, (await page.locator("body").innerText()).slice(-3000));
      }
      throw error;
    } finally {
      await browser.close();
    }
  }
  console.log(
    "Project memory UI passed settings, stable terrain, scoped recall practice, original evidence, and withdrawal on desktop and H5.",
  );
} finally {
  await app.dispose();
}
