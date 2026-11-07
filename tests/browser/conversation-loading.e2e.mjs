import { createBrowserFixture } from "../support/browser-runtime.mjs";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { artifact, launchOptions } from "../support/browser-runtime.mjs";
import { createConversationHistory } from "../../src/server/conversation/history.js";
const runtime = await createBrowserFixture();
const port = Number(new URL(runtime.base).port);
let browser;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    try {
      if ((await fetch(`${base}/api/health`, { headers: runtime.headers })).ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  const fixtureCwd = (
    await fetch(`${base}/api/config`, { headers: runtime.headers }).then((response) => response.json())
  ).home;
  const thread = {
    id: "paged",
    cwd: fixtureCwd,
    turns: [
      {
        id: "turn",
        status: "completed",
        items: Array.from({ length: 250 }, (_, i) =>
          i === 0
            ? { id: "user", type: "userMessage", content: [{ type: "text", text: "Original prompt" }] }
            : i === 249
              ? {
                  id: "final",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Latest answer\n\n" + "Earlier answer details.\n\n".repeat(25),
                }
              : {
                  id: `tool-${i}`,
                  type: "commandExecution",
                  status: "completed",
                  command: "echo history",
                  aggregatedOutput: `output ${i}`,
                },
        ),
      },
    ],
  };
  const history = createConversationHistory({ readThread: async () => thread, fingerprint: () => 1 });
  const first = await history.read({ threadId: "paged" }),
    second = await history.read({ threadId: "paged", cursor: first.history.nextCursor }),
    third = await history.read({ threadId: "paged", cursor: second.history.nextCursor });
  const unchanged = await history.read({
    threadId: "paged",
    revision: first.history.revision,
    oldestItemId: third.history.oldestItemId,
  });
  browser = await (process.env.PANDA_FORCE_TEST_BROWSER === "webkit"
    ? webkit.launch()
    : chromium.launch(launchOptions()));
  const context = await browser.newContext();
  await runtime.signIn(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => globalThis.__pandaForceDebug?.state.connected);
  await page.evaluate(
    ({ first, second, third, unchanged }) => {
      const api = globalThis.__pandaForceDebug;
      api.state.ws.onmessage = null;
      api.state.events?.close();
      api.mutations.set("transport", "sse");
      api.startNewTask();
      api.applyThreadSummaries([
        { id: "paged", name: "Paged history", cwd: api.state.config.home },
        { id: "other", name: "Other", cwd: api.state.config.home },
      ]);
      window.__historyCalls = [];
      window.__holdHistory = false;
      window.__holdEarlier = false;
      window.__earlierResolvers = [];
      window.__snapshotRefresh = false;
      window.__failHistory = false;
      const original = window.fetch;
      window.fetch = async (resource, options = {}) => {
        if (new URL(typeof resource === "string" ? resource : resource.url, location.href).pathname !== "/api/rpc")
          return original(resource, options);
        const call = JSON.parse(options.body);
        window.__historyCalls.push(call);
        let result = { data: [] };
        if (call.method === "host/thread/history") {
          if (window.__failHistory)
            return Response.json({ type: "rpc/error", id: call.id, error: "History fixture unavailable" });
          if (call.params.threadId === "other")
            result = {
              thread: { id: "other", turns: [] },
              history: { mode: "snapshot", turns: [], revision: "other" },
            };
          else if (call.params.cursor) result = call.params.cursor === first.history.nextCursor ? second : third;
          else if (call.params.revision) {
            // An unchanged refresh keeps the cursor for the caller's loaded range.
            const range =
              [first, second, third].find((page) => page.history.oldestItemId === call.params.oldestItemId) || first;
            result = {
              ...unchanged,
              history: {
                ...unchanged.history,
                oldestItemId: range.history.oldestItemId,
                nextCursor: range.history.nextCursor,
              },
            };
            if (window.__snapshotRefresh) {
              result = first;
              window.__snapshotRefresh = false;
            }
          } else result = first;
          if (window.__holdEarlier && call.params.cursor)
            return new Promise((resolve) =>
              window.__earlierResolvers.push(() => resolve(Response.json({ type: "rpc/result", id: call.id, result }))),
            );
          if (window.__holdHistory && call.params.threadId === "paged")
            return new Promise(
              (resolve) =>
                (window.__resolveHistory = () => resolve(Response.json({ type: "rpc/result", id: call.id, result }))),
            );
        }
        return Response.json({ type: "rpc/result", id: call.id, result });
      };
    },
    { first, second, third, unchanged },
  );
  await page.evaluate(() => globalThis.__pandaForceDebug.openThread("paged"));
  assert.equal(await page.locator(".activity-item").count(), 99);
  assert.ok(
    (await page.locator("[data-local-conversation-final-assistant]").textContent()).trim().startsWith("Latest answer"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__holdEarlier = true;
  });
  await page.locator(".load-older").click();
  await page.waitForFunction(() => window.__earlierResolvers.length === 1);
  assert.equal(await page.locator(".load-older").isDisabled(), true);
  assert.equal(await page.locator(".load-older").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator(".load-older").innerText(), "Loading earlier messages…");
  assert.equal(await page.locator(".load-older .conversation-loading-spinner").isVisible(), true);
  const buttonBounds = await page.locator(".load-older").boundingBox();
  assert.ok(buttonBounds.x >= 0 && buttonBounds.x + buttonBounds.width <= 390);
  await page.evaluate(() => {
    window.__olderButton = document.querySelector(".load-older");
    window.__snapshotRefresh = true;
    window.dispatchEvent(new Event("focus"));
  });
  await page.waitForFunction(() => document.querySelector(".load-older") !== window.__olderButton);
  assert.equal(await page.locator(".load-older").isDisabled(), true, "Background rendering must retain loading state");
  await page.locator(".load-older").dispatchEvent("click");
  assert.equal(
    await page.evaluate(() => window.__earlierResolvers.length),
    1,
    "A loading page must not be requested twice",
  );
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("zh-CN"));
  assert.equal(await page.locator(".load-older").innerText(), "正在加载更早消息…");
  await page.screenshot({ path: artifact("earlier-history-feedback/loader-h5.png") });
  await page.evaluate(() => globalThis.__pandaForceI18n.setPreference("en"));
  // Movement during the request must win over the position at click time.
  const reading = page.locator('[data-item-id="final"]');
  assert.equal(await reading.isVisible(), true);
  await reading.evaluate((node) => {
    const root = document.querySelector("#conversation");
    root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top + 80;
  });
  const readingTop = await reading.evaluate((node) => node.getBoundingClientRect().top);
  await page.evaluate(() => {
    window.__paginationTouchTarget = document.querySelector('[data-item-id="final"] p');
    const event = new Event("touchstart", { bubbles: true });
    Object.defineProperty(event, "touches", { value: [{ clientY: 200 }] });
    window.__paginationTouchTarget.dispatchEvent(event);
    window.__holdEarlier = false;
    window.__earlierResolvers.shift()();
  });
  await page.waitForFunction(
    () => globalThis.__pandaForceDebug.state.active.turns.reduce((count, turn) => count + turn.items.length, 0) === 200,
  );
  assert.equal(await page.locator(".activity-item").count(), 99, "A full projection waits for the active touch");
  assert.equal(
    await page.locator(".load-older").isDisabled(),
    true,
    "Loading covers both the request and its pending projection",
  );
  assert.equal(await page.locator(".load-older").getAttribute("aria-busy"), "true");
  await page.evaluate(() => {
    const event = new Event("touchend", { bubbles: true });
    Object.defineProperty(event, "touches", { value: [] });
    window.__paginationTouchTarget.dispatchEvent(event);
  });
  await page.waitForFunction(() => document.querySelectorAll(".activity-item").length === 199);
  assert.equal(await page.locator(".activity-item").count(), 199);
  assert.ok(
    Math.abs((await reading.evaluate((node) => node.getBoundingClientRect().top)) - readingTop) < 2,
    "Loading earlier history must retain the latest reading position",
  );
  assert.equal(await page.locator(".load-older").isDisabled(), false);
  assert.equal(await page.locator(".load-older").getAttribute("aria-busy"), "false");
  assert.equal(await page.locator(".load-older .conversation-loading-spinner").isVisible(), false);
  await page.evaluate(() => {
    window.__failHistory = true;
  });
  await page.locator(".load-older").click();
  await page.waitForFunction(() => document.querySelector(".load-older")?.disabled === false);
  assert.equal(await page.locator(".activity-item").count(), 199, "A failed request keeps the existing history");
  await page.evaluate(() => {
    window.__failHistory = false;
  });
  await page.locator(".load-older").click();
  await page.waitForFunction(() => document.querySelectorAll(".activity-item").length === 248);
  assert.equal(await page.locator(".activity-item").count(), 248);
  assert.equal(await page.locator(".user-message").textContent(), "Original prompt");
  assert.equal(await page.locator(".load-older").count(), 0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(async () => {
    await globalThis.__pandaForceDebug.openThread("other");
    window.__holdHistory = true;
    window.__cachedOpen = globalThis.__pandaForceDebug.openThread("paged");
  });
  assert.ok(
    (await page.locator("[data-local-conversation-final-assistant]").textContent()).trim().startsWith("Latest answer"),
  );
  assert.equal(await page.locator(".conversation-loading").count(), 0);
  await page.waitForFunction(() => window.__resolveHistory);
  await page.evaluate(async () => {
    window.__resolveHistory();
    await window.__cachedOpen;
    window.__holdHistory = false;
  });
  assert.equal(await page.locator(".activity-item").count(), 248);
  const calls = await page.evaluate(() => window.__historyCalls);
  assert.equal(
    calls.some((call) => call.method === "thread/read"),
    false,
  );
  assert.ok(calls.some((call) => call.params?.revision && call.params?.oldestItemId));
  assert.deepEqual(errors, []);
  // A real page reload must show persisted content before either network history or the list returns.
  const saved = await page.evaluate(() => globalThis.__pandaForceDebug.persistentConversationCache.get("paged"));
  assert.equal(saved.history.revision, first.history.revision);
  assert.equal(saved.turns[0].items.length, 100);
  const reloadStarted = performance.now();
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url, ...args) {
        if (String(url).endsWith("/ws")) throw new Error("Use SSE for reload test");
        super(url, ...args);
      }
    };
  });
  const held = [];
  let connection;
  await page.route("**/api/events*", (route) => {
    connection = route;
  });
  await page.route("**/api/rpc", async (route) => {
    const call = route.request().postDataJSON();
    if (call.method === "thread/list") {
      held.push({ route, result: { data: [{ id: "paged", name: "Paged history", cwd: fixtureCwd }] } });
      return;
    }
    if (call.method === "host/thread/history") {
      held.push({ route, result: await history.read(call.params), call });
      return;
    }
    await route.fulfill({ json: { type: "rpc/result", id: call.id, result: { data: [] } } });
  });
  const syncRequest = page.waitForRequest(
    (request) => request.url().endsWith("/api/rpc") && request.postDataJSON()?.method === "host/thread/history",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-local-conversation-final-assistant]", { state: "attached" });
  const cachedReloadMs = Math.round(performance.now() - reloadStarted);
  assert.ok(
    (await page.locator("[data-local-conversation-final-assistant]").textContent()).trim().startsWith("Latest answer"),
  );
  assert.equal(await page.locator(".conversation-loading").count(), 0);
  assert.equal(await page.locator(".activity-item").count(), 99);
  assert.equal(await page.locator(".load-older").count(), 1);
  assert.equal(await page.evaluate(() => globalThis.__pandaForceDebug.state.connected), false);
  assert.ok(connection);
  await connection.continue();
  await page.unroute("**/api/events*");
  const revalidation = (await syncRequest).postDataJSON();
  assert.equal(revalidation.params.revision, first.history.revision);
  assert.equal(revalidation.params.oldestItemId, "turn:tool-150");
  for (let attempt = 0; attempt < 100 && !held.some((value) => value.call); attempt++) await Bun.sleep(10);
  assert.equal(held.find((value) => value.call)?.result.history.mode, "delta");
  assert.equal(held.find((value) => value.call)?.result.history.turns.length, 0);
  for (const { route, result } of held)
    await route.fulfill({ json: { type: "rpc/result", id: route.request().postDataJSON().id, result } });
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.active?.history?.unchanged === true);
  assert.deepEqual(errors, []);
  const eviction = await page.evaluate(async () => {
    const cache = globalThis.__pandaForceDebug.persistentConversationCache,
      now = Date.now(),
      hour = 60 * 60 * 1000;
    const old = { id: "expired", updatedAt: (now - 49 * hour) / 1000, turns: [] };
    await cache.put(old);
    const expiredWrite = (await cache.get(old.id)) === null;
    const recent = { id: "recent", updatedAt: (now - 47 * hour) / 1000, turns: [] };
    await cache.put(recent);
    const recentRetained = Boolean(await cache.get(recent.id));
    const originalNow = Date.now;
    let expiredAfterRefresh;
    try {
      Date.now = () => now + 2 * hour;
      await cache.put(recent);
      expiredAfterRefresh = (await cache.get(recent.id)) === null;
    } finally {
      Date.now = originalNow;
    }
    // Seed an entry written by the previous cache version to verify physical cleanup.
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(
        "panda-force-conversations-v1" +
          (globalThis.__pandaForceIdentityKey ? ":" + globalThis.__pandaForceIdentityKey : ""),
        1,
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const access = (mode, action) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("entries", mode);
        action(tx.objectStore("entries"));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    await access("readwrite", (store) => store.put({ id: "legacy", updatedAt: now, thread: { ...old, id: "legacy" } }));
    await cache.prune();
    let legacy;
    await access("readonly", (store) => {
      const request = store.get("legacy");
      request.onsuccess = () => (legacy = request.result);
    });
    const deleted = { id: "cache-delete", updatedAt: now / 1000, turns: [] };
    await cache.put(deleted);
    await cache.saveSummaries([{ id: "cache-delete" }, { id: "paged" }]);
    await cache.remove(deleted.id);
    await cache.put(deleted);
    let deletedRecord;
    await access("readonly", (store) => {
      const request = store.get(deleted.id);
      request.onsuccess = () => (deletedRecord = request.result);
    });
    db.close();
    const deletionEvicted =
      !deletedRecord &&
      (await cache.get(deleted.id)) === null &&
      !(await cache.summaries()).some((thread) => thread.id === deleted.id);
    return { expiredWrite, recentRetained, expiredAfterRefresh, legacyPruned: !legacy, deletionEvicted };
  });
  assert.deepEqual(eviction, {
    expiredWrite: true,
    recentRetained: true,
    expiredAfterRefresh: true,
    legacyPruned: true,
    deletionEvicted: true,
  });
  // Storage restrictions must leave network loading usable.
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, "indexedDB", {
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    }),
  );
  await page.unroute("**/api/rpc");
  let deletedByUI = false;
  await page.route("**/api/rpc", (route) => {
    const call = route.request().postDataJSON();
    if (!["host/thread/history", "thread/list", "thread/delete"].includes(call.method)) return route.continue();
    if (call.method === "thread/delete") deletedByUI = true;
    const result =
      call.method === "host/thread/history"
        ? first
        : call.method === "thread/list"
          ? { data: deletedByUI ? [] : [{ id: "paged", name: "Paged history", cwd: fixtureCwd }] }
          : { data: [] };
    return route.fulfill({ json: { type: "rpc/result", id: call.id, result } });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-local-conversation-final-assistant]", { state: "attached" });
  assert.ok(
    (await page.locator("[data-local-conversation-final-assistant]").textContent()).trim().startsWith("Latest answer"),
  );
  assert.deepEqual(errors, []);
  await page.locator("#workspacePreparation").waitFor({ state: "hidden" });
  page.on("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => globalThis.__pandaForceDebug.setSidebarOpen(true));
  await page.locator('.thread-item[data-id="paged"] .thread-options').click();
  // A background list refresh must retain the open menu and its keyboard focus.
  const refreshedMenu = await page.evaluate(() => {
    const api = globalThis.__pandaForceDebug;
    const focused = document.activeElement;
    api.applyThreadSummaries(
      api.state.threads.map((thread) =>
        thread.id === "paged" ? { ...thread, name: "Refreshed paged history" } : thread,
      ),
    );
    const menu = document.querySelector('.sidebar-project-menu[role="menu"]');
    return {
      visible: Boolean(menu && !menu.hidden),
      focusRetained: document.activeElement === focused,
      expanded: document.querySelector('.thread-item[data-id="paged"] .thread-options')?.getAttribute("aria-expanded"),
    };
  });
  assert.deepEqual(refreshedMenu, { visible: true, focusRetained: true, expanded: "true" });
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .locator('.thread-item[data-id="paged"] .thread-options')
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.locator('.thread-item[data-id="paged"] .thread-options').click();
  await page.getByRole("menuitem", { name: "Delete session", exact: true }).click();
  await page.locator(".confirmation-dialog").getByRole("button", { name: "Delete session", exact: true }).click();
  await page.waitForFunction(() => globalThis.__pandaForceDebug.state.active === null);
  assert.equal(deletedByUI, true);
  await page.waitForFunction(() => !globalThis.__pandaForceDebug.state.threads.some((thread) => thread.id === "paged"));
  assert.deepEqual(errors, []);
  await page.unroute("**/api/rpc");
  await page.route("**/api/rpc", (route) => {
    const call = route.request().postDataJSON();
    if (call.method === "host/thread/history")
      return route.fulfill({ status: 401, json: { error: "Authentication required" } });
    return route.continue();
  });
  await page.evaluate(async () => {
    const api = globalThis.__pandaForceDebug;
    api.applyThreadSummaries([{ id: "expired-history", name: "Expired history", cwd: "/tmp" }]);
    await api.openThread("expired-history");
  });
  await page.getByText("Sign in again to load this conversation. Your history has not been deleted.").waitFor();
  assert.equal(await page.getByText("Send a message to start fresh.", { exact: false }).count(), 0);
  await page.evaluate(() => {
    window.reauthenticationRequested = false;
    addEventListener("panda-force:reauthenticate", () => (window.reauthenticationRequested = true));
  });
  await page.locator("#conversation").getByRole("button", { name: "Sign in again", exact: true }).click();
  assert.equal(await page.evaluate(() => window.reauthenticationRequested), true);

  console.log(
    JSON.stringify({
      boundedHistory: true,
      olderPages: true,
      loadingFeedbackAndRetry: true,
      duplicateLoadsPrevented: true,
      pendingLoadReadingPosition: true,
      persistentReloadBeforeNetwork: true,
      cachedReloadMs,
      revisionRevalidation: true,
      storageUnavailableFallback: true,
      inactive48HourEviction: true,
      deletionEviction: true,
    }),
  );
} finally {
  await browser?.close();
  await runtime.dispose();
}
