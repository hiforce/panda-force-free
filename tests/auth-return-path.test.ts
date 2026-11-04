import { expect, test } from "bun:test";
import { safeAuthReturnPath, sessionLoginUrl } from "../src/shared/auth-return-path.js";

test("login returns to an application route with its query and fragment", () => {
  const path = "/task/thread-123?view=changes#latest";
  expect(safeAuthReturnPath(path)).toBe(path);
  expect(new URL(sessionLoginUrl(path), "https://app.example").searchParams.get("returnTo")).toBe(path);
  for (const path of ["/", "/workspace", "/new", "/projects", "/project?cwd=%2Fhome%2Fcode", "/settings/appearance"])
    expect(safeAuthReturnPath(path)).toBe(path);
  expect(sessionLoginUrl("/")).toBe("/auth/login");
});

test("untrusted return destinations cannot leave the app or restart authentication", () => {
  for (const path of [
    null, "", "https://evil.example/", "//evil.example/", "/\\evil.example/", "/auth/login", "/auth/callback?code=x",
    "/api/auth/logout", "/style.css", "/%61uth/login", "/task/x\r\nLocation:https://evil.example", "/" + "x".repeat(4096),
  ]) {
    expect(safeAuthReturnPath(path)).toBe("/");
    expect(sessionLoginUrl(path)).toBe("/auth/login");
  }
});
