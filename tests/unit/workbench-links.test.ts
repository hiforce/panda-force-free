import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { workbenchLinkPath } from "../../src/client/workbench-route.js";

const dom = new JSDOM("", { url: "https://example.test/create" });
function path(href: string, attributes = {}, event = {}) {
  const anchor = dom.window.document.createElement("a");
  anchor.href = href;
  for (const [key, value] of Object.entries(attributes)) anchor.setAttribute(key, String(value));
  return workbenchLinkPath(anchor, { button: 0, ...event }, dom.window.location.href);
}

test("application links share the router with or without navigation markers", () => {
  for (const href of [
    "/skills/writing",
    "/settings/bots",
    "/bots",
    "/project?id=project-id&tab=sessions",
    "/documents?project=personal&document=doc-id",
    "/publish/x?project=project-id",
    "/task/session-id",
    "/",
  ]) {
    expect(path(href)).toBe(href);
    expect(path(href, { "data-wb": "route", "data-route": href })).toBe(href);
  }
  expect(path("https://example.test/skills/writing")).toBe("/skills/writing");
  expect(path("/skills/writing#versions")).toBe("/skills/writing#versions");
});

test("browser actions, downloads, external destinations and local fragments remain native", () => {
  for (const event of [
    { button: 1 },
    { button: 2 },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { defaultPrevented: true },
  ])
    expect(path("/skills/writing", {}, event)).toBeNull();
  for (const attributes of [
    { download: "" },
    { target: "_blank" },
    { target: "named-window" },
    { rel: "external noopener" },
    { "data-native-navigation": "" },
  ])
    expect(path("/skills/writing", attributes)).toBeNull();
  expect(path("/skills/writing", { target: "_self" })).toBe("/skills/writing");
  for (const href of [
    "https://external.test/skills/writing",
    "https://example.test:8443/skills",
    "/api/cli/manual",
    "/auth/login",
    "/unknown-page",
    "mailto:test@example.test",
    "javascript:void(0)",
    "http://[",
    "#section",
    "/create#section",
    "",
  ])
    expect(path(href)).toBeNull();
});
