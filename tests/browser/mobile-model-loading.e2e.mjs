import { createBrowserFixture } from "../support/browser-runtime.mjs";
import assert from "node:assert/strict";
import { devices } from "playwright";
import { launchOptions } from "../support/browser-runtime.mjs";
const runtime = await createBrowserFixture({
  models: [
    {
      id: "glm-5.3-flash",
      model: "glm-5.3-flash",
      displayName: "GLM 5.3 Flash",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
    {
      id: "qwen3-coder:30b",
      model: "qwen3-coder:30b",
      displayName: "Local Ollama model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
  ],
});
const base = runtime.base;
let browser;
try {
  browser = await runtime.launchBrowser(launchOptions());
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("panda-force-locale", "en");
    delete window.Notification;
    window.__modelsViaWs = 0;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      send(data) {
        if (JSON.parse(data).method === "model/list") {
          window.__modelsViaWs++;
          return;
        }
        super.send(data);
      }
    };
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0;
  await page.route("**/api/rpc", (route) => {
    if (route.request().postDataJSON().method === "model/list" && ++requests === 1) return route.abort("failed");
    return route.continue();
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.modelLoadStatus === "ready");
  assert.equal(requests, 2);
  assert.equal(await page.locator("#settingsTaskNotifyToggle").isEnabled(), false);
  assert.equal(await page.locator("#composerSteerHint").count(), 0);
  assert.equal(await page.evaluate(() => window.__modelsViaWs), 0);
  assert.ok((await page.evaluate(() => globalThis.__pandaForceDebug.state.models.length)) > 0);
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.selectedModel), "glm-5.3-flash");
  assert.deepEqual(await page.evaluate(() => globalThis.__pandaForceDebug.state.models.map((model) => model.model)), [
    "glm-5.3-flash",
    "qwen3-coder:30b",
  ]);
  // A response that never arrives must time out and expose a usable retry action.
  const failure = await page.evaluate(async () => {
    const api = globalThis.__pandaForceDebug,
      original = window.fetch;
    window.__workingModelFetch = original;
    window.__modelAttempts = 0;
    window.fetch = (resource, options = {}) => {
      if (
        new URL(resource, location.href).pathname === "/api/rpc" &&
        JSON.parse(options.body).method === "model/list"
      ) {
        window.__modelAttempts++;
        return new Promise((resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), {
            once: true,
          }),
        );
      }
      return original(resource, options);
    };
    api.mutations.set("models", []);
    await api.loadModels({ timeoutMs: 100, attempts: 2, retryDelayMs: 10 });
    return {
      status: api.state.modelLoadStatus,
      label: document.querySelector("#modelLabel").textContent,
      attempts: window.__modelAttempts,
      busy: document.querySelector("#modelButton").getAttribute("aria-busy"),
    };
  });
  assert.deepEqual(failure, { status: "error", label: "Model load failed · Retry", attempts: 2, busy: "false" });
  await page.evaluate(() => {
    window.fetch = window.__workingModelFetch;
  });
  await page.locator("#modelButton").click();
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.modelLoadStatus === "ready");
  assert.equal(await page.locator("#modelButton").getAttribute("aria-busy"), "false");
  assert.equal(await page.evaluate(() => window.__modelsViaWs), 0);
  assert.deepEqual(errors, []);
  console.log("Mobile Chrome model reads, transient failure recovery, bounded timeout and click-to-retry passed.");
} finally {
  await browser?.close();
  await runtime.dispose();
}
