import { afterEach, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createWorkspacePreparation } from "../../src/client/workspace-preparation.js";

const active: any[] = [];
function fixture() {
  jest.useFakeTimers();
  const dom = new JSDOM(readFileSync(new URL("../../public/index.html", import.meta.url), "utf8"));
  const reload = jest.fn();
  const api = createWorkspacePreparation({ root: dom.window.document, onReload: reload });
  const panel = dom.window.document.querySelector("#workspacePreparation") as HTMLElement;
  const progress = panel.querySelector("progress") as HTMLProgressElement;
  active.push({ api, dom });
  return { api, panel, progress, reload };
}
afterEach(() => {
  for (const { api, dom } of active.splice(0)) {
    api.dispose();
    dom.window.close();
  }
  jest.useRealTimers();
});

test("preparation stays hidden before authentication and progress advances only on completed reads", () => {
  const f = fixture();
  expect(f.panel.hidden).toBe(true);
  f.api.begin();
  f.api.complete("interface");
  expect(f.panel.hidden).toBe(false);
  expect(f.progress.value).toBe(1);
  jest.advanceTimersByTime(6000);
  expect(f.progress.value).toBe(1);
  expect(f.panel.textContent).toContain("taking a little longer");
  expect((f.panel.querySelector("#workspacePreparationReload") as HTMLElement).hidden).toBe(false);
  f.api.complete("configuration");
  expect(f.progress.value).toBe(2);
});

test("errors and stalled reads never become a successful 100 percent state", async () => {
  const f = fixture();
  f.api.begin();
  await f.api.track("models", Promise.resolve(false));
  expect(f.panel.dataset.status).toBe("error");
  expect(f.progress.value).toBe(0);
  jest.advanceTimersByTime(46000);
  expect(f.panel.hidden).toBe(false);
  expect(f.panel.dataset.status).toBe("error");
  (f.panel.querySelector("#workspacePreparationReload") as HTMLButtonElement).click();
  expect(f.reload).toHaveBeenCalledTimes(1);
});

test("a successful preparation closes once and changing language does not reopen it", () => {
  const f = fixture();
  f.api.begin();
  for (const id of ["interface", "connection", "configuration", "projects", "sessions", "models", "permissions"])
    f.api.complete(id);
  expect(f.progress.value).toBe(7);
  expect(f.panel.dataset.status).toBe("ready");
  jest.advanceTimersByTime(401);
  expect(f.panel.hidden).toBe(true);
  f.api.refresh();
  f.api.start("models");
  expect(f.panel.hidden).toBe(true);
});

test("an older failed read cannot overwrite a newer successful read", async () => {
  const f = fixture();
  f.api.begin();
  let rejectOld: any;
  const old = f.api
    .track(
      "projects",
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
    )
    .catch(() => {});
  await f.api.track("projects", Promise.resolve({ revision: 1 }));
  rejectOld(new Error("old request failed"));
  await old;
  expect(f.panel.querySelector('[data-step="projects"]')?.getAttribute("data-status")).toBe("ready");
  expect(f.progress.value).toBe(1);
});

test("partial retry only runs unfinished registered reads and notifies subscribers", async () => {
  const f = fixture();
  const snapshots: any[] = [];
  f.api.subscribe((value: any) => snapshots.push(value));
  f.api.begin();
  f.api.complete("interface");
  f.api.complete("projects");
  f.api.fail("configuration");
  const configuration = jest.fn(async () => ({ ok: true })),
    projects = jest.fn(async () => ({ ok: true }));
  f.api.registerRetry("configuration", configuration);
  f.api.registerRetry("projects", projects);
  await f.api.retry();
  expect(configuration).toHaveBeenCalledTimes(1);
  expect(projects).not.toHaveBeenCalled();
  expect(f.progress.value).toBe(3);
  expect(snapshots.at(-1).steps.find((step: any) => step.id === "configuration").status).toBe("ready");
  expect(f.panel.dataset.status).not.toBe("ready");
});
