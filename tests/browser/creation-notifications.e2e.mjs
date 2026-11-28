import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import sharp from "sharp";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";

const out = process.env.PANDA_NOTIFICATION_PROOF || ".artifacts/creation-notifications";
await mkdir(out, { recursive: true });
const records = [];
for (const kind of ["document", "image"]) {
  const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#168c9b" } })
    .png()
    .toBuffer();
  const app = await createAppFixture({
    applicationCreation: true,
    startupTimeoutMs: 60000,
    ...(kind === "image" ? { applicationImage: image.toString("base64") } : {}),
    models: [
      {
        id: "fixture",
        model: "fixture",
        displayName: "Fixture",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      },
    ],
  });
  try {
    let saved;
    for (const [engine, width] of [
      [chromium, 1440],
      [webkit, 390],
    ]) {
      const browser = await engine.launch();
      try {
        const context = await browser.newContext({
          viewport: { width, height: 950 },
          isMobile: width < 768,
          hasTouch: width < 768,
        });
        await app.signIn(context);
        const api = async (path, data) => {
          const response = await context.request.fetch(app.base + path, {
            method: data ? "POST" : "GET",
            headers: { Origin: app.base },
            ...(data ? { data } : {}),
          });
          assert(response.ok(), await response.text());
          return response.json();
        };
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (e) => {
          errors.push(e.message);
          console.error("Inbox browser error", e.stack);
        });
        await page.goto(app.base + "/tasks");
        await page
          .locator("#notificationCenterButton")
          .waitFor()
          .catch(async (error) => {
            console.error("Inbox bootstrap", {
              errors,
              url: page.url(),
              controls: await page.evaluate(() => ({
                count: document.querySelectorAll("#notificationCenterButton").length,
                identity: globalThis.__pandaForceIdentityKey,
                globalActions: document.querySelector(".workbench-global-actions")?.outerHTML,
              })),
            });
            throw error;
          });
        if (!saved) {
          const options = await api("/api/personal/document-creations/options"),
            id = crypto.randomUUID();
          await api("/api/personal/document-creations", {
            id,
            projectId: "personal",
            parentId: null,
            treeVersion: 0,
            locale: "en",
            prompt: "Create a finished notification example",
            outputType: kind,
            ...(kind === "image" ? { media: { kind: "image", source: "harness" } } : {}),
            profileId: options.defaultProfileId,
            selections: options.defaultWorkflow ? [options.defaultWorkflow] : [],
          });
          const answered = new Set();
          saved = await waitFor(async () => {
            const task = (await api("/api/personal/document-creations/detail?id=" + id)).task;
            assert(!task.failure, JSON.stringify(task.failure));
            if (task.question && !answered.has(task.question.id)) {
              answered.add(task.question.id);
              await api("/api/personal/document-creations/answer", {
                id: task.question.id,
                answers: Object.fromEntries(
                  task.question.questions.map((q) => [q.id, { answers: [q.options?.[0]?.label || "General readers"] }]),
                ),
              });
            }
            return task.state === "succeeded" ? task : null;
          }, 60000);
          await page.evaluate(() => dispatchEvent(new Event("focus")));
          await page.locator("#notificationCenterButton .notification-center-badge:visible").waitFor();
        }
        for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
          await page.evaluate((value) => globalThis.__pandaForceI18n.setPreference(value), locale);
          await page.locator("#notificationCenterButton").click();
          const dialog = page.locator("#notificationCenterDialog"),
            item = dialog.locator(
              `[data-notification-key^="personal-creation:"][data-notification-key$=".${saved.id}.${saved.generation}"]`,
            );
          await item.waitFor();
          assert((await dialog.boundingBox()).width <= (width > 767 ? 520 : width - 24) + 1);
          assert(!(await dialog.evaluate((el) => getComputedStyle(el).fontFamily)).includes("Times New Roman"));
          assert.equal(await item.locator("strong").textContent(), saved.artifact.title);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
          const box = await item.boundingBox();
          assert(box.width >= 44 && box.height >= 44);
          await page.screenshot({ path: `${out}/${kind}-${locale}-${width}.png` });
          await dialog.locator("[data-notifications-close]").click();
          records.push({ kind, width, locale, savedDelivery: true, touchTarget: true, noOverflow: true });
        }
        await page.locator("#notificationCenterButton").click();
        const item = page.locator(
          `#notificationCenterDialog [data-notification-key^="personal-creation:"][data-notification-key$=".${saved.id}.${saved.generation}"]`,
        );
        await item.focus();
        await page.keyboard.press("Enter");
        if (kind === "document") {
          await page.waitForURL(/\/documents\?/);
          const route = new URL(page.url());
          assert.equal(route.searchParams.get("project"), saved.artifact.projectId);
          assert.equal(route.searchParams.get("document"), saved.artifact.documentId);
        } else {
          const viewer = page.locator("[data-personal-reader]:visible");
          await viewer.locator("a[download]").first().waitFor();
          const image = viewer.locator("img[data-asset-native]");
          await waitFor(() =>
            image.evaluate(
              (element) => element.complete && element.naturalWidth === 640 && element.naturalHeight === 480,
            ),
          );
          const source = new URL(await image.getAttribute("src"), app.base);
          assert.equal(source.searchParams.get("id"), saved.artifact.assetId);
          assert.equal(source.searchParams.get("version"), saved.artifact.version);
        }
        await waitFor(
          async () =>
            (await api("/api/personal/document-creations/notifications")).items.find((x) => x.taskId === saved.id)
              ?.readAt,
        );
        await page.waitForLoadState("networkidle");
        await page.reload();
        await page.locator("#notificationCenterButton").click();
        await page
          .locator(
            `#notificationCenterDialog [data-notification-key^="personal-creation:"][data-notification-key$=".${saved.id}.${saved.generation}"][data-unread="false"]`,
          )
          .waitFor();
        if (kind === "document") {
          await page.locator("#notificationCenterDialog [data-notifications-close]").click();
          await page.waitForLoadState("networkidle");
          await page.goto(app.base + "/task/old-alpha");
          await page.locator("#sessionInfoButton").click();
          await page.locator("#sessionInspector:visible").waitFor();
          assert.equal(
            await page.locator("#sessionInspectorFooter, #sessionToolShortcuts, #sessionProjectCode").count(),
            0,
          );
          assert.equal(await page.locator(".session-working-folder svg").count(), 0);
          for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
            await page.evaluate((value) => globalThis.__pandaForceI18n.setPreference(value), locale);
            const selector = page.locator("#sessionAssociateProject");
            const box = await selector.boundingBox();
            assert(box.height >= 44);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: `${out}/context-${locale}-${width}.png` });
          }
          let waiting = false,
            failed = false;
          await page.route("**/api/personal/document-creations/detail?*", async (route) => {
            if (failed) return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
            const response = await route.fetch(),
              body = await response.json();
            body.task = {
              ...body.task,
              state: "running",
              artifact: null,
              failure: null,
              updatedAt: Date.now(),
              progress: [{ stage: "started", generation: saved.generation, at: Date.now() - 120000 }],
              question: waiting
                ? {
                    id: "awaiting-user",
                    questions: [
                      {
                        id: "audience",
                        header: "Audience",
                        question: "Who should this help?",
                        isOther: true,
                        options: [{ label: "Readers", description: "A short guide" }],
                      },
                    ],
                  }
                : null,
            };
            return route.fulfill({ response, json: body });
          });
          await page.goto(app.base + "/creation/" + saved.id + "?creationScope=personal");
          const draft = page.locator("#prompt");
          await draft.fill("Preserve my next instructions");
          for (const locale of ["en", "zh-CN", "zh-HK", "zh-TW"]) {
            await page.evaluate((value) => globalThis.__pandaForceI18n.setPreference(value), locale);
            const messages = JSON.parse(await readFile(`src/shared/i18n/locales/${locale}/creation.json`, "utf8"));
            await page.getByText(messages.longRunningHint, { exact: true }).waitFor();
            await page.screenshot({ path: `${out}/long-running-${locale}-${width}.png` });
          }
          if (width === 1440) {
            failed = true;
            await page.locator('.creation-session-notice[data-phase="error"]').waitFor();
            assert.equal(await draft.inputValue(), "Preserve my next instructions");
            failed = false;
            await page.locator('.creation-session-notice[data-phase="error"] button').click();
          }
          waiting = true;
          await page.locator(".creation-session-status .user-input-card").waitFor();
          assert.equal(await page.locator(".creation-session-notice").textContent(), "");
          assert.equal(await draft.inputValue(), "Preserve my next instructions");
        }
        assert.deepEqual(errors, []);
        await context.close();
      } finally {
        await browser.close();
      }
    }
  } finally {
    await app.dispose();
  }
}
await writeFile(
  out + "/proof.json",
  JSON.stringify(
    { passed: true, records, completionOnAnotherPage: true, readPersistsAfterReload: true, exactDeliveryOpened: true },
    null,
    2,
  ),
);
console.log("Durable completion inbox and exact deliveries passed on PC/H5 in four locales.");
