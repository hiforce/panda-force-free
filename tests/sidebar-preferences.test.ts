import { createI18nRuntime } from "../src/shared/i18n/runtime.js";
const english = createI18nRuntime().t;
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createThreadSidebar } from "../src/client/threads-sidebar.js";

test("folder sidebar sorting, pagination and pin persistence are independent of session activity", async () => {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    url: "https://fixture.example",
  });
  const globals = [
    "document",
    "window",
    "localStorage",
    "addEventListener",
    "removeEventListener",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "CSS",
    "innerWidth",
    "innerHeight",
  ];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const key of globals)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value:
          key === "CSS"
            ? { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => "\\" + char) }
            : key === "requestAnimationFrame"
              ? () => 0
              : key === "cancelAnimationFrame"
                ? () => {}
                : typeof dom.window[key] === "function"
                  ? dom.window[key].bind(dom.window)
                  : dom.window[key],
      });
    const threads = Array.from({ length: 12 }, (_, i) => ({
      id: "page-" + i,
      name: "Session " + i,
      cwd: "/projects/recent",
      updatedAt: 1000 - i,
    }));
    threads.push({ id: "older", name: "Older", cwd: "/projects/older", updatedAt: 100 });
    const state = {
      threads,
      active: threads[0],
      config: { home: "/home" },
      projectless: false,
      workspaceContext: null,
    };
    const $ = (selector) => dom.window.document.querySelector(selector);
    const create = () =>
      createThreadSidebar({
        state,
        $,
        t: english,
        escapeHtml: (value) => String(value),
        shortPath: (path) => path,
        titleOf: (thread) => thread.name,
        readVisibility: async () => ({ revision: 0, hiddenProjects: {} }),
        updateThreadRowMeta: () => {},
        onRender: () => {},
      });
    const sidebar = create();
    await sidebar.loadProjectVisibility();
    const order = () =>
      [...dom.window.document.querySelectorAll('.sidebar-project-group:not([data-project="__pinned__"])')].map(
        (node) => node.dataset.project,
      );
    const recent = () => dom.window.document.querySelector('[data-project="/projects/recent"]');
    expect(order()).toEqual(["/projects/older", "/projects/recent"]);
    expect(recent().querySelectorAll(".thread-item").length).toBe(5);
    threads[0].updatedAt = 9999999999;
    sidebar.renderThreads();
    expect(order()).toEqual(["/projects/older", "/projects/recent"]);
    const expanded = recent().querySelector(".sidebar-project-row").getAttribute("aria-expanded");
    sidebar.toggleProjectPinned("/projects/recent");
    expect(order()).toEqual(["/projects/recent", "/projects/older"]);
    expect(recent().querySelector(".sidebar-project-row").getAttribute("aria-expanded")).toBe(expanded);
    recent().querySelector(".sidebar-sessions-more").click();
    expect(recent().querySelectorAll(".thread-item").length).toBe(10);
    recent().querySelector(".sidebar-sessions-more").click();
    expect(recent().querySelectorAll(".thread-item").length).toBe(12);
    expect(recent().querySelector(".sidebar-sessions-more")).toBeNull();
    recent().querySelector(".thread-options").click();
    [...dom.window.document.querySelectorAll('[role="menuitem"]')]
      .find((node) => node.textContent === "Pin session")
      .click();
    const pinned = () => dom.window.document.querySelector('[data-project="__pinned__"]');
    expect([...pinned().querySelectorAll(".thread-item")].map((node) => node.dataset.id)).toEqual(["page-0"]);
    expect(JSON.parse(dom.window.localStorage.getItem("panda-force-sidebar-pinned-threads"))).toEqual(["page-0"]);
    pinned().querySelector(".thread-options").click();
    [...dom.window.document.querySelectorAll('[role="menuitem"]')]
      .find((node) => node.textContent === "Unpin session")
      .click();
    expect(pinned().querySelector(".sidebar-pinned-empty").textContent).toBe("No pinned sessions");
    const restored = create();
    await restored.loadProjectVisibility();
    expect(restored.isProjectPinned("/projects/recent")).toBe(true);
    expect(order()).toEqual(["/projects/recent", "/projects/older"]);
  } finally {
    for (const key of globals) {
      const value = previous.get(key);
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
