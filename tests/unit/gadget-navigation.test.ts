import { workbenchRouteSurface, parseWorkbenchRoute } from "../../src/client/workbench-route.js";
import { test, expect } from "bun:test";
import { gadgetApplicationNavigation, systemGadgetCapabilities } from "../../src/gadget/system/bindings.js";
import type { ProjectionCapability } from "../../src/gadget/system/bindings.js";
test("the application admits gadget routes without exposing external navigation or API endpoints", () => {
  const calls: string[] = [],
    navigate = gadgetApplicationNavigation((path) => calls.push(path));
  for (const path of [
    "https://outside.example/",
    "//outside.example",
    "/api/logout",
    "/bots\\outside",
    "/tasks\r\nanything",
  ])
    navigate(path);
  expect(calls).toEqual([]);
  navigate("/task/test-session");
  navigate("/project?id=test-project");
  navigate("/bots");
  expect(calls).toEqual(["/task/test-session", "/project?id=test-project", "/bots"]);
});

test("recent and attention projections use the common opener so history authorization stays with the application", () => {
  const opened: string[] = [];
  const capabilities = systemGadgetCapabilities({
    identity: "owner",
    navigate: () => {
      throw Error("Session opens must use the shared opener");
    },
    openSession: (id) => opened.push(id),
    creationProject: () => "personal",
    startTask() {},
    taskDraft: () => "",
    ready: () => true,
    sessions: () => [{ id: "known-session", name: "Current conversation" }],
    projects: () => [],
    projectForSession: () => null,
    status: () => "common.ready",
  });
  const sessions = capabilities.get("panda.sessions") as ProjectionCapability;
  expect(sessions.open?.("known-session")).toBe(true);
  expect(sessions.open?.("not-in-the-projection")).toBe(true);
  expect(sessions.open?.("")).toBe(false);
  expect(sessions.open?.("x".repeat(201))).toBe(false);
  expect(opened).toEqual(["known-session", "not-in-the-projection"]);
});

test("route surfaces keep keyboard and page ownership independent of presentation classes", () => {
  for (const path of ["/new", "/task/known", "/creation/known", "/create", "/workspace?creation=known"])
    expect(workbenchRouteSurface(new URL(path, "https://app.example"))).toBe("conversation");
  for (const path of [
    "/workspace",
    "/tasks",
    "/projects",
    "/create?view=works",
    "/create?view=activity",
    "/create?asset=known",
  ])
    expect(workbenchRouteSurface(new URL(path, "https://app.example"))).toBe("workspace");
  const base = new URL("/workspace", "https://app.example");
  expect(workbenchRouteSurface(base, parseWorkbenchRoute(new URL("/settings/profile", base)))).toBe("settings");
});
