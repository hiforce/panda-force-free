import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchOptions } from "./browser-runtime.mjs";
import { createProjectVisibilityFixture } from "./project-visibility-fixture.mjs";

const fixture = await createProjectVisibilityFixture();
let browser;

async function openPage() {
  const context = await browser.newContext();
  const login = await context.request.post(`${fixture.base}/api/auth/login`, {
    data: { password: "visibility-test" },
  });
  assert.equal(login.ok(), true);
  await context.addInitScript(() => {
    if (window === window.top) localStorage.setItem("codex-webui-locale", "en");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

async function checkBackgroundFailure(method) {
  const { context, page, errors } = await openPage();
  try {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread("old-alpha"));
    await page.evaluate((heldMethod) => {
      const api = globalThis.__codexWebuiDebug;
      api.state.ws.onmessage = null;
      api.state.events?.close();
      api.state.transport = "sse";
      window.failureCalls = 0;
      const originalFetch = window.fetch;
      window.fetch = async (resource, options = {}) => {
        const url = new URL(typeof resource === "string" ? resource : resource.url, location.href);
        if (url.pathname === "/api/rpc") {
          const call = JSON.parse(options.body);
          if (call.method === heldMethod) {
            window.failureCalls++;
            if (window.failureCalls === 1) {
              return new Promise((resolve) => {
                window.rejectPendingSend = () =>
                  resolve(Response.json({ type: "rpc/error", id: call.id, error: "Simulated rejection" }));
              });
            }
          }
        }
        return originalFetch(resource, options);
      };
    }, method);
    const text = `Recover rejected ${method}`;
    await page.locator("#prompt").fill(text);
    if (method === "thread/queue/add") await page.locator("#queueButton").click();
    else await page.locator("#composer").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => window.rejectPendingSend);
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread("old-beta"));
    await page.locator("#prompt").fill("Keep the other session's draft");
    await page.evaluate(() => window.rejectPendingSend());
    await page.waitForFunction((expected) => {
      const drafts = JSON.parse(localStorage.getItem("codex-webui-composer-drafts") || "{}");
      return drafts["old-alpha"]?.text === expected;
    }, text);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep the other session's draft");
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread("old-alpha"));
    assert.equal(await page.locator("#prompt").inputValue(), text);
    // Retrying must reach the bridge: a lock stranded in finally would suppress it.
    if (method === "thread/queue/add") {
      await page.locator("#queueButton").click();
      await page.locator('.message-queue-row[data-status="queued"]').waitFor();
    } else {
      await page.locator("#composer").evaluate((form) => form.requestSubmit());
      await page.locator('.user-turn[data-delivery="sent"]').waitFor();
    }
    assert.equal(await page.evaluate(() => window.failureCalls), 2);
    assert.equal(await page.locator("#prompt").inputValue(), "");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function checkVisibilityFailure() {
  const { context, page, errors } = await openPage();
  try {
    await context.addInitScript(() => {
      if (window === window.top) localStorage.setItem("codex-webui-active-thread", "old-alpha");
    });
    await page.route("**/api/projects/visibility", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Simulated outage"}' }),
    );
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.waitForFunction(
      (cwd) =>
        globalThis.__codexWebuiDebug?.state.workspaceContext?.cwd === cwd &&
        globalThis.__codexWebuiDebug.state.active?.id === "old-alpha",
      fixture.alpha,
    );
    assert.deepEqual(errors, []);
    // A temporary project-list failure must also allow the rest of startup to run.
    assert.equal(await page.evaluate(() => globalThis.__codexWebuiDebug.state.modelLoadStatus), "ready");
    await page.unroute("**/api/projects/visibility");
    await page.evaluate(() => globalThis.__codexWebuiDebug.loadInitial());
    await page.locator('.thread-item[data-id="old-alpha"]').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function checkRequestTimeout(method) {
  const { context, page, errors } = await openPage();
  try {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__codexWebuiDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(() => globalThis.__codexWebuiDebug.openThread("old-alpha"));
    await page.clock.install();
    await page.evaluate((heldMethod) => {
      const api = globalThis.__codexWebuiDebug;
      api.state.ws.onmessage = null;
      api.state.events?.close();
      api.state.transport = "sse";
      api.state.active.canAcceptDirectInput = heldMethod !== "thread/resume";
      api.state.composerAttachments = Array.from({ length: 6 }, (_, i) => ({
        id: `pose-${i}`, name: `${i + 1}.png`, path: `/tmp/pose-${i}.png`, kind: "image", status: "ready",
      }));
      window.timeoutCalls = 0;
      const originalFetch = window.fetch;
      window.fetch = (resource, options = {}) => {
        const url = new URL(typeof resource === "string" ? resource : resource.url, location.href);
        if (url.pathname === "/api/rpc" && JSON.parse(options.body).method === heldMethod) {
          window.timeoutCalls++;
          if (window.timeoutCalls === 1) {
            return new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            });
          }
        }
        return originalFetch(resource, options);
      };
    }, method);
    const text = `Replace six poses after ${method}`;
    await page.locator("#prompt").fill(text);
    await page.locator("#composer").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => window.timeoutCalls === 1);
    await page.clock.fastForward(45_001);
    const preparation = method === "thread/resume";
    await page.locator(`.user-turn[data-delivery="${preparation ? "failed" : "unconfirmed"}"]`).waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), preparation ? text : "");
    assert.equal(await page.evaluate(() => globalThis.__codexWebuiDebug.state.composerAttachments.length), preparation ? 6 : 0);
    assert.equal(await page.evaluate(() => window.timeoutCalls), 1);
    if (preparation) {
      // The recovered draft and six attachments can be submitted with a fresh click.
      await page.locator("#composer").evaluate((form) => form.requestSubmit());
      await page.locator('.user-turn[data-delivery="sent"]').waitFor();
      assert.equal(await page.evaluate(() => window.timeoutCalls), 2);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch(launchOptions());
  await checkBackgroundFailure("turn/start");
  await checkBackgroundFailure("thread/queue/add");
  await checkVisibilityFailure();
  await checkRequestTimeout("thread/resume");
  await checkRequestTimeout("turn/start");
  console.log("Background rejection recovery, visibility outages, six-attachment timeout recovery and uncertain delivery passed.");
} finally {
  await browser?.close();
  await fixture.dispose();
}
