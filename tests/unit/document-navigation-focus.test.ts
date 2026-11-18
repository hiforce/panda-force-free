import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createWorkbenchLayout } from "../../src/client/workbench-chrome/layout.js";

function fixture() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example" });
  const keys = ["document", "localStorage", "matchMedia"],
    previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let desktop = true,
    navigation = true,
    details = true;
  for (const [key, value] of Object.entries({
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    matchMedia: () => ({ matches: desktop }),
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  dom.window.localStorage.setItem("panda-force-sidebar-open", "true");
  const layout = createWorkbenchLayout({
    readSidebar: () => navigation,
    setSidebar: (open) => {
      navigation = open;
    },
    readDetails: () => details,
    setDetails: (open) => {
      details = open;
    },
    hasSession: () => true,
  });
  return {
    layout,
    dom,
    open: () => navigation,
    hide: () => {
      navigation = false;
    },
    mobile: () => {
      desktop = false;
    },
    desktop: () => {
      desktop = true;
    },
    dispose: () => {
      for (const key of keys) {
        const value = previous.get(key);
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}
test("document navigation focus restores the prior sidebar without changing its preference", () => {
  const f = fixture();
  try {
    f.layout.setDocumentFocus(true);
    expect(f.open()).toBe(false);
    expect(f.dom.window.document.body.classList.contains("document-navigation-focus")).toBe(true);
    f.layout.setDocumentFocus(true);
    f.layout.setPanel("navigation", true);
    expect(f.open()).toBe(true);
    f.layout.setDocumentFocus(false);
    expect(f.open()).toBe(true);
    expect(f.dom.window.localStorage.getItem("panda-force-sidebar-open")).toBe("true");
    f.hide();
    f.layout.setDocumentFocus(true);
    f.layout.setDocumentFocus(false);
    expect(f.open()).toBe(false);
  } finally {
    f.dispose();
  }
});
test("document and global focus may end in either order without losing the original panels", () => {
  for (const first of ["global", "document"]) {
    const f = fixture();
    try {
      if (first === "global") {
        f.layout.setFocus(true);
        f.layout.setDocumentFocus(true);
        f.layout.setFocus(false);
        expect(f.open()).toBe(false);
        f.layout.setDocumentFocus(false);
      } else {
        f.layout.setDocumentFocus(true);
        f.layout.setFocus(true);
        f.layout.setDocumentFocus(false);
        expect(f.open()).toBe(false);
        f.layout.setFocus(false);
      }
      expect(f.open()).toBe(true);
    } finally {
      f.dispose();
    }
  }
});
test("leaving a document on mobile never opens a navigation drawer", () => {
  const f = fixture();
  try {
    f.layout.setDocumentFocus(true);
    f.mobile();
    f.layout.setDocumentFocus(false);
    expect(f.open()).toBe(false);
    f.layout.setDocumentFocus(true);
    f.desktop();
    f.layout.setDocumentFocus(false);
    expect(f.open()).toBe(true);
  } finally {
    f.dispose();
  }
});
