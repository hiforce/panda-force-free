import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { migrateBrowserState } from "../../src/client/legacy-browser-state.js";
test("draft and locale migration preserves explicit PandaForce values and unrelated application data", () => {
  const dom = new JSDOM("", { url: "https://workspace.example" });
  const s = dom.window.localStorage;
  try {
    s.setItem("codex-webui-composer-drafts", "unsent");
    s.setItem("codex-webui-locale", "zh-CN");
    s.setItem("panda-force-locale", "en");
    s.setItem("other-app", "keep");
    migrateBrowserState(s);
    expect(s.getItem("panda-force-composer-drafts")).toBe("unsent");
    expect(s.getItem("panda-force-locale")).toBe("en");
    expect(s.getItem("codex-webui-composer-drafts")).toBeNull();
    expect(s.getItem("other-app")).toBe("keep");
    migrateBrowserState(s);
    expect(s.getItem("panda-force-composer-drafts")).toBe("unsent");
  } finally {
    dom.window.close();
  }
});
test("a blocked write never discards the old draft", () => {
  const values = new Map([["codex-webui-composer-drafts", "unsent"]]);
  const s = {
    length: 1,
    key: () => [...values.keys()][0],
    getItem: (k: string) => values.get(k) ?? null,
    setItem: () => {
      throw Error("Quota exceeded");
    },
    removeItem: (k: string) => values.delete(k),
  };
  migrateBrowserState(s);
  expect(values.get("codex-webui-composer-drafts")).toBe("unsent");
});
