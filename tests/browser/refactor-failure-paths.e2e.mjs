import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchOptions } from "../support/browser-runtime.mjs";
import { createAppFixture } from "../support/app-fixture.mjs";
const fixture = await createAppFixture();
let browser;
async function openPage() {
  const context = await browser.newContext();
  await fixture.signIn(context);
  await context.addInitScript(() => {
    if (window === window.top) localStorage.setItem("panda-force-locale", "en");
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
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
    await page.evaluate((heldMethod) => {
      const api = globalThis.__pandaForceDebug;
      api.state.ws.onmessage = null;
      api.state.events?.close();
      api.mutations.set("transport", "sse");
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
                  resolve(
                    Response.json({
                      type: "rpc/error",
                      id: call.id,
                      error: "Simulated rejection",
                    }),
                  );
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
    await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-beta"));
    await page.locator("#prompt").fill("Keep the other session's draft");
    await page.evaluate(() => window.rejectPendingSend());
    await page.waitForFunction((expected) => {
      const drafts = JSON.parse(localStorage.getItem("panda-force-composer-drafts") || "{}");
      return drafts["old-alpha"]?.text === expected;
    }, text);
    assert.equal(await page.locator("#prompt").inputValue(), "Keep the other session's draft");
    await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
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
      if (window === window.top) localStorage.setItem("panda-force-active-thread", "old-alpha");
    });
    await page.route("**/api/projects/visibility", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Simulated outage"}',
      }),
    );
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.waitForFunction(
      (cwd) =>
        globalThis.__pandaForceDebug?.state.workspaceContext?.cwd === cwd &&
        globalThis.__pandaForceDebug.state.active?.id === "old-alpha",
      fixture.alpha,
    );
    assert.deepEqual(errors, []);
    // A temporary project-list failure must also allow the rest of startup to run.
    assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.modelLoadStatus), "ready");
    await page.unroute("**/api/projects/visibility");
    await page.evaluate(() => globalThis.__pandaForceDebug.loadInitial());
    await page.locator('.thread-item[data-id="old-alpha"]').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
async function checkRequestTimeout(prepareInput) {
  const method = "turn/start";
  const { context, page, errors } = await openPage();
  try {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(() => globalThis.__pandaForceDebug.openThread("old-alpha"));
    await page.clock.install();
    await page.evaluate(
      ({ heldMethod, prepareInput }) => {
        const api = globalThis.__pandaForceDebug;
        api.state.ws.onmessage = null;
        api.state.events?.close();
        api.mutations.set("transport", "sse");
        api.mutations.edit("active", (draft) => (draft.canAcceptDirectInput = !prepareInput));
        api.mutations.set(
          "composerAttachments",
          Array.from({ length: 6 }, (_, i) => ({
            id: `pose-${i}`,
            name: `${i + 1}.png`,
            path: `/tmp/pose-${i}.png`,
            kind: "image",
            status: "ready",
          })),
        );
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
      },
      { heldMethod: method, prepareInput },
    );
    const text = `Replace six poses after ${prepareInput ? "combined preparation" : method}`;
    await page.locator("#prompt").fill(text);
    await page.locator("#composer").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => window.timeoutCalls === 1);
    await page.clock.fastForward(45001);
    await page.locator('.user-turn[data-delivery="unconfirmed"]').waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), "");
    assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.composerAttachments.length), 0);
    assert.equal(await page.evaluate(() => window.timeoutCalls), 1);
    // A lost combined acknowledgement cannot prove that preparation stopped before input.
    // Keep the six images in the message bubble and never replay the mutation automatically.
    assert.equal(await page.locator('.user-turn[data-delivery="unconfirmed"] .user-message-images img').count(), 6);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
async function checkInterruptedPreparation(locale, persistent = false) {
  const { context, page, errors } = await openPage();
  try {
    await context.addInitScript((language) => {
      if (window === window.top) localStorage.setItem("panda-force-locale", language);
    }, locale);
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
    await page.evaluate(async () => {
      const api = globalThis.__pandaForceDebug;
      await api.openThread("old-alpha");
      api.state.ws.onmessage = null;
      api.state.events?.close();
      api.mutations.set("transport", "sse");
      api.mutations.edit("active", (draft) => (draft.canAcceptDirectInput = false));
      api.mutations.set("composerAttachments", [
        {
          id: "draft-image",
          name: "reference.png",
          path: "/tmp/reference.png",
          kind: "image",
          status: "ready",
        },
      ]);
    });
    let turns = 0;
    await page.route("**/api/rpc", async (route) => {
      const call = route.request().postDataJSON();
      if (call.method === "turn/start") {
        turns++;
        assert.equal(call.params.pandaPrepareInput, true);
        if (persistent) return route.abort("connectionreset");
        if (turns === 1)
          return route.fulfill({ json: { type: "rpc/error", id: call.id, error: "Synthetic preparation rejection" } });
      }
      return route.continue();
    });
    const text = `Keep this message and reference image: ${locale}, ${persistent ? "offline" : "recovered"}`;
    await page.locator("#prompt").fill(text);
    await page.locator("#composer").evaluate((form) => {
      globalThis.__pandaForceDebug.mutations.edit("active", (draft) => (draft.canAcceptDirectInput = false));
      form.requestSubmit();
    });
    await page.waitForFunction(
      ({ text, delivery }) =>
        [...document.querySelectorAll(".user-turn")].some(
          (node) => node.dataset.delivery === delivery && node.textContent.includes(text),
        ),
      { text, delivery: persistent ? "unconfirmed" : "failed" },
    );
    assert.equal(turns, 1);
    assert.doesNotMatch(await page.locator("#persistentErrors").innerText(), /Failed to fetch/);
    if (persistent) {
      assert.equal(await page.locator("#prompt").inputValue(), "");
      assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.composerAttachments.length), 0);
      assert.equal(await page.locator('.user-turn[data-delivery="unconfirmed"] .user-message-images img').count(), 1);
      assert.match(
        await page.locator("#persistentErrors").innerText(),
        locale === "zh-CN" ? /发送待确认/ : /Delivery unconfirmed/,
      );
    } else {
      // A definitive preparation rejection preserves the draft for an explicit retry.
      assert.equal(await page.locator("#prompt").inputValue(), text);
      assert.equal(
        await page.evaluate(() => globalThis.__pandaForceDebug.state.composerAttachments[0].name),
        "reference.png",
      );
      await page.locator("#composer").evaluate((form) => form.requestSubmit());
      await page.locator('.user-turn[data-delivery="sent"]').waitFor();
      assert.equal(turns, 2);
      assert.equal(await page.locator("#prompt").inputValue(), "");
      assert.equal(
        fixture.calls().filter((call) => call.method === "turn/start" && call.params.input?.[0]?.text === text).length,
        1,
      );
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
  await checkRequestTimeout(true);
  await checkRequestTimeout(false);
  await checkInterruptedPreparation("en");
  await checkInterruptedPreparation("en", true);
  await checkInterruptedPreparation("zh-CN", true);
  console.log("Single-request preparation, rejection recovery, attachment preservation and uncertain delivery passed.");
} finally {
  await browser?.close();
  await fixture.dispose();
}
