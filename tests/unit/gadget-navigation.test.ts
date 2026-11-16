import { test, expect } from "bun:test";
import { gadgetApplicationNavigation } from "../../src/gadget/system/bindings.js";
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
