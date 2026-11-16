import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { sidebarSessionGroups } from "../../src/client/sidebar-session-groups.js";
import { createSessionModelCache } from "../../src/client/session-controls/model-cache.js";
import { createModelCatalogLoader } from "../../src/client/session-controls/model-loader.js";
import { captureRenderFocus, restoreRenderFocus } from "../../src/client/render-focus.js";
import { GadgetMounts } from "../../src/client/gadget/mounts.js";
import { ClientGadgetRegistry, type GadgetContext } from "../../src/client/gadget/contracts.js";
import type { GadgetInstance, GadgetManifest } from "../../src/shared/gadget/contracts.js";
import { publicationFormatCapabilities } from "../../src/shared/publishing/format-capabilities.js";
import type { Translate } from "../../src/shared/i18n/messages.js";

let dom: JSDOM | undefined;
const globals = ["document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "CSS"] as const;
const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
function documentFixture() {
  dom = new JSDOM('<body><main></main><aside><input id="outside"></aside></body>');
  for (const key of globals)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "CSS" ? { escape: (s: string) => s } : dom.window[key],
    });
  return document.querySelector("main")!;
}
afterEach(() => {
  dom?.window.close();
  dom = undefined;
  globals.forEach((key, index) => {
    const descriptor = previous[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
});

test("sidebar preserves pinned, hidden, empty-project and paginated history behavior without mutating sessions", () => {
  const sessions = Array.from({ length: 13 }, (_, n) =>
    Object.freeze({ id: String(n), cwd: "alpha", name: "Task " + n, time: n }),
  );
  const options = {
    sessions,
    allSessions: sessions,
    projects: [
      { id: "alpha", name: "Alpha" },
      { id: "empty", name: "Empty" },
    ],
    query: "",
    hidden: { "project:alpha": false },
    pinnedSessions: new Set(["1"]),
    pinnedProjects: new Set<string>(),
    expansion: { "project:alpha": false },
    activeSession: "1",
    currentProject: "project:alpha",
    pageSize: 5,
    limits: new Map<string, number>(),
    projectKey: () => "project:alpha",
    projectName: (id: string) => id,
    title: (s: (typeof sessions)[number]) => s.name,
    activity: (s: (typeof sessions)[number]) => s.time,
    compare: (a: string, b: string) => a.localeCompare(b),
  };
  const hidden = sidebarSessionGroups(options);
  expect(hidden.map((g) => g.key)).toEqual(["__pinned__", "__tasks__", "project:empty"]);
  expect(hidden[0]!.visibleThreads.map((s) => s.id)).toEqual(["1"]);
  const shown = sidebarSessionGroups({ ...options, hidden: {} }).find((g) => g.key === "project:alpha")!;
  expect(shown.expanded).toBe(false);
  expect(shown.visibleThreads.map((s) => s.id)).toEqual(["12", "11", "10", "9", "8"]);
  expect(shown.hasMore).toBe(true);
  const search = sidebarSessionGroups({ ...options, hidden: {}, query: "project:alpha" }).find(
    (g) => g.key === "project:alpha",
  )!;
  expect(search.visibleThreads).toHaveLength(13);
  expect(search.expanded).toBe(true);
  expect(sessions.map((s) => s.id)).toEqual(Array.from({ length: 13 }, (_, n) => String(n)));
});

test("optional model preferences repair corrupt storage and treat prototype-like session IDs as data", () => {
  let value = "broken json";
  const cache = createSessionModelCache({
    get: () => value,
    set: (_key, next) => {
      value = next;
    },
  });
  expect(cache.read("session")).toBeNull();
  cache.write("__proto__", { model: "model-a", effort: "high" });
  expect(cache.read("__proto__")).toEqual({ model: "model-a", effort: "high" });
  expect(cache.read("constructor")).toBeNull();
  cache.write("session", { model: "model-b" });
  cache.clear("__proto__");
  expect(cache.read("__proto__")).toBeNull();
  expect(cache.read("session")).toEqual({ model: "model-b" });
});

test("model catalog joins concurrent callers, reports one terminal failure and permits a later retry", async () => {
  const statuses: string[] = [],
    failures: unknown[] = [],
    accepted: unknown[] = [];
  let calls = 0,
    fail = true;
  const load = createModelCatalogLoader({
    request: async () => {
      calls++;
      await Bun.sleep(1);
      if (fail) throw new Error("offline");
      return { type: "rpc/result", result: { data: [{ id: "model-a", model: "model-a", displayName: "Model A" }] } };
    },
    setStatus: (s: string) => statuses.push(s),
    changed: () => {},
    accept: (m: unknown) => accepted.push(m),
    failed: (e: unknown) => failures.push(e),
  });
  const first = load({ attempts: 2, retryDelayMs: 1 });
  expect(load()).toBe(first);
  expect(await first).toBe(false);
  expect(calls).toBe(2);
  expect(failures).toHaveLength(1);
  expect(statuses).toEqual(["loading", "error"]);
  fail = false;
  expect(await load({ attempts: 1 })).toBe(true);
  expect(accepted).toHaveLength(1);
});

test("render focus keeps complete selections, ignores external focus and supports non-text controls", () => {
  const root = documentFixture();
  root.innerHTML = '<textarea id="draft">A complete draft</textarea><input id="count" type="number" value="4">';
  const input = root.querySelector("textarea")!;
  input.focus();
  input.setSelectionRange(2, 10, "backward");
  const snapshot = captureRenderFocus(root);
  root.replaceChildren(...Array.from(root.childNodes, (node) => node.cloneNode(true)));
  restoreRenderFocus(root, snapshot);
  const replacement = root.querySelector("textarea")!;
  expect(document.activeElement).toBe(replacement);
  expect([replacement.selectionStart, replacement.selectionEnd, replacement.selectionDirection]).toEqual([
    2,
    10,
    "backward",
  ]);
  (document.querySelector("#outside") as HTMLElement).focus();
  expect(captureRenderFocus(root)).toBeNull();
  const count = root.querySelector<HTMLInputElement>("#count")!;
  count.focus();
  const numeric = captureRenderFocus(root);
  expect(numeric?.selection).toBeNull();
  root.replaceChildren(...Array.from(root.childNodes, (node) => node.cloneNode(true)));
  expect(() => restoreRenderFocus(root, numeric)).not.toThrow();
});

test("gadget lifecycle cancels pending mounts, scopes capabilities and disposes once across config changes", async () => {
  const root = documentFixture(),
    registry = new ClientGadgetRegistry();
  const names = { en: "Test", "zh-CN": "测试", "zh-HK": "測試", "zh-TW": "測試" };
  const manifest: GadgetManifest = {
    id: "system.test",
    apiVersion: 1,
    version: "1",
    configVersion: 1,
    title: names,
    description: names,
    icon: "test",
    singleton: false,
    source: "system",
    layout: { w: 1, h: 1, minW: 1, minH: 1 },
    config: {},
    permissions: [],
    services: [],
    actions: [],
    clientCapabilities: ["allowed"],
    minRefreshSeconds: 0,
  };
  const instance: GadgetInstance = {
    id: "test",
    gadget: manifest.id,
    configVersion: 1,
    config: {},
    title: "Test",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    visible: { desktop: true, mobile: true },
  };
  const contexts: GadgetContext[] = [],
    navigated: string[] = [],
    failures: string[] = [];
  let disposed = 0;
  registry.register(manifest, {
    mount: () => ({
      update: (context) => {
        contexts.push(context);
      },
      dispose: () => {
        disposed++;
      },
    }),
  });
  let resolveFrontend!: (value: string) => void;
  const mounts = new GadgetMounts({
    registry,
    t: ((s: string) => s) as Translate,
    locale: () => "en",
    api: {
      frontend: () =>
        new Promise<string>((resolve) => {
          resolveFrontend = resolve;
        }),
      invoke: async () => ({ navigate: "//untrusted.invalid" }),
    },
    budget: { read: (_key, _seconds, _signal, work) => work() },
    events: { publish: () => true, subscribe: () => {} },
    capabilities: new Map([
      ["allowed", { safe: true }],
      ["secret", {}],
    ]),
    navigate: (p) => navigated.push(p),
    notice: () => {},
    code: () => "unavailable",
    failure: (id) => failures.push(id),
  });
  root.append(mounts.ensure(instance.id).element);
  mounts.update(instance, manifest);
  await Bun.sleep(0);
  const context = contexts[0]!;
  expect(context.capability("allowed")).toEqual({ safe: true });
  expect(() => context.capability("secret")).toThrow();
  await context.action("open");
  expect(navigated).toEqual([]);
  mounts.update({ ...instance, config: { changed: true } }, manifest);
  await Bun.sleep(0);
  expect(context.signal.aborted).toBe(true);
  expect(disposed).toBe(1);
  mounts.clear();
  mounts.clear();
  expect(disposed).toBe(2);
  const missing = { ...instance, id: "lazy", gadget: "extension.lazy" };
  root.append(mounts.ensure(missing.id).element);
  mounts.update(missing, { ...manifest, id: missing.gadget, frontend: true });
  mounts.remove(missing.id);
  resolveFrontend("ignored");
  await Bun.sleep(0);
  expect(root.children).toHaveLength(0);
  expect(failures).toEqual([]);
});

test("shared publication capabilities keep Post, Thread, Article and HTML distinct", () => {
  expect(publicationFormatCapabilities("x-thread")?.composition).toBe("thread");
  expect(publicationFormatCapabilities("x-thread")?.delivery).toBe("post");
  expect(publicationFormatCapabilities("x-article")?.rich.inlineStyles.strong).toBe(true);
  expect(publicationFormatCapabilities("x-article")?.rich.inlineStyles.underline).toBe(false);
  expect(publicationFormatCapabilities("wechat")?.representation).toBe("html");
  expect(publicationFormatCapabilities("__proto__")).toBeNull();
  expect(publicationFormatCapabilities("unknown")).toBeNull();
});
