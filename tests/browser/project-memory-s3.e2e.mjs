import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createEncryptionKey } from "../../src/client/encryption-keys/key-store.ts";
import { encodeMemoryPackage, memoryPackageRecipient } from "../../src/server/project-memory/pmf.ts";
import { createMemoryArchive } from "../../src/server/project-memory/portability.ts";
import { objectStorageFixture } from "../support/object-storage-fixture.js";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const storage = await objectStorageFixture();
if (!storage) throw new Error("An isolated S3 fixture is required");
const output = process.env.PANDA_FORCE_MEMORY_S3_PROOF || ".artifacts/project-memory-s3";
await mkdir(output, { recursive: true });
const app = await createAppFixture({ startupTimeoutMs: 60000 });
try {
  for (const [engine, width, locale, theme] of [
    [chromium, 1366, "en", "silk"],
    [webkit, 390, "zh-CN", "silk"],
    [webkit, 390, "zh-HK", "aurora"],
    [webkit, 320, "zh-TW", "aurora"],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: width < 700,
        isMobile: width < 700,
      });
      await app.signIn(context);
      await context.addInitScript(
        ({ locale, theme }) => {
          localStorage.setItem("panda-force-locale", locale);
          localStorage.setItem("panda-force-theme", theme);
        },
        { locale, theme },
      );
      const api = async (path, data) => {
        const response = await context.request.fetch(app.base + path, {
          method: data === undefined ? "GET" : "POST",
          data,
          headers: { Origin: app.base },
        });
        assert(response.ok(), "Unexpected API status " + response.status() + " for " + path);
        return response.json();
      };
      const bucket = "panda-memory-pcf-" + randomUUID();
      const created = await storage.request("PUT", "/" + bucket);
      assert.equal(created.status, 200);
      await created.body?.cancel();
      const config = await api("/api/system/storage");
      const configured = await api("/api/system/storage", {
        revision: config.revision,
        operationId: randomUUID(),
        action: "configure",
        mode: "s3",
        kinds: ["project-memory-package"],
        profile: {
          ...storage.connection(bucket),
          label: "Private memory",
          prefix: "owned",
          credentials: storage.credentials,
        },
      });
      assert.deepEqual(configured.settings.kinds, ["project-memory-package"]);
      const page = await context.newPage();
      await page.goto(app.base + "/settings/storage");
      const option = page.locator('[data-storage-kind="project-memory-package"]');
      await option.waitFor();
      assert(await option.isChecked());
      assert(!(await page.locator('[data-storage-kind="image"]').isChecked()));
      await page.screenshot({ path: output + "/storage-" + locale + ".png" });
      const projects = await api("/api/projects");
      const code = "pmf-" + locale.toLowerCase();
      const next = await api("/api/projects", {
        revision: projects.revision,
        operationId: randomUUID(),
        name: "S3 memory",
        code,
      });
      const project = next.projects.find((item) => item.code === code);
      assert(project);
      const path = "/api/projects/" + project.id + "/";
      const route =
        app.base + "/project?" + new URLSearchParams({ id: project.id, tab: "memory", memoryView: "records" });
      const passphrase = "isolated S3 memory fixture";
      const backup = await createEncryptionKey("S3 fixture", passphrase);
      const manifest = createMemoryArchive([{ key: "cache", scope: "release", values: ["48 hours"] }], Date.now());
      const bytes = encodeMemoryPackage(manifest, memoryPackageRecipient(backup.publicKey));
      const pending = "[data-package-action=choose]";
      await page.goto(route);
      const open = page.locator("[data-memory-packages-import]");
      await open.click();
      const dialog = page.locator(".memory-package-dialog");
      await dialog
        .locator("[data-memory-package-file]")
        .setInputFiles({ name: "release.pmf", mimeType: "application/octet-stream", buffer: bytes });
      const trigger = dialog.locator("[data-memory-package-review]");
      assert(!(await dialog.locator("[data-memory-package-unlock]").isVisible()));
      await trigger.click();
      await waitFor(async () =>
        (await api(path + "memory-upload")).transfers.some((task) =>
          ["queued", "checking", "awaiting-key"].includes(task.state),
        ),
      );
      await page.close();

      const resumed = await context.newPage();
      await resumed.goto(route);
      await resumed.locator("[data-memory-packages-import]").click();
      const modal = resumed.locator(".memory-package-dialog");
      await modal.locator(pending).waitFor();
      await modal.locator(pending).click();
      await modal.locator("[data-memory-package-settings]").waitFor();
      await resumed.screenshot({ path: output + "/queued-" + locale + ".png" });
      await resumed.evaluate((item) => {
        localStorage.setItem("pf-encryption-keys:" + globalThis.__pandaForceIdentityKey, JSON.stringify([item]));
      }, backup);
      await modal.locator(pending).click();
      await modal.locator("[data-memory-package-unlock] input").fill(passphrase);
      await modal.locator("[data-memory-package-review]").click();
      await modal.locator(".memory-package-preview-list").getByText("48 hours", { exact: true }).waitFor();
      assert(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      assert(await modal.locator("[data-memory-queue]").isHidden());
      await resumed.screenshot({ path: output + "/preview-" + locale + ".png" });
      await modal.locator('button[type="submit"]').click();
      await modal.locator("[data-package-withdraw]").waitFor();
      await waitFor(async () => (await api(path + "memory-upload")).transfers.length === 0);
      await modal.locator("[data-memory-package-close]").click();
      await resumed.locator("[data-memory-entries]").getByText("48 hours", { exact: true }).waitFor();
    } finally {
      await browser.close();
    }
  }
  console.log("Project memory S3 storage, background queue, reopen, unlock and import passed on desktop and H5.");
} finally {
  try {
    await app.dispose();
  } finally {
    await storage.close();
  }
}
