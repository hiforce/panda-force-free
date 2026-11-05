import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { setMessageHtml } from "../../src/client/i18n.js";
import { renderAssistantMarkdown } from "../../src/client/rendering.js";
import { escapeHtml } from "../../src/shared/html.js";
import { errorText } from "../../src/client/i18n/errors.js";
import { createI18n } from "../../src/client/i18n.js";

describe("HTML trust boundaries", () => {
  test("interface writes remove executable payloads while retaining forms, bindings and SVG", () => {
    const dom = new JSDOM("");
    try {
      const root = dom.window.document.createElement("div");
      setMessageHtml(
        root,
        '<form><input name="projectName"><button type="submit">Save</button></form><svg viewBox="0 0 24 24"><path d="M0 0h1"></path></svg><span data-pf-message="common.close"></span><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><iframe srcdoc="bad"></iframe><script>alert(1)</script>',
      );
      expect(root.querySelector('[name="projectName"]')).not.toBeNull();
      expect(root.querySelector('button[type="submit"]')).not.toBeNull();
      expect(root.querySelector("svg path")).not.toBeNull();
      expect(root.querySelector("[data-pf-message]")?.textContent).toBe("Close");
      expect(root.querySelector("[onerror],iframe,script,a[href]")).toBeNull();
      setMessageHtml(root, `<span>${escapeHtml("<img src=x onerror=alert(1)>")}</span>`);
      expect(root.querySelector("img")).toBeNull();
      expect(root.textContent).toBe("<img src=x onerror=alert(1)>");
    } finally {
      dom.window.close();
    }
  });
  test("model HTML cannot forge interface controls, bindings or CSS; generated math and image controls survive", () => {
    const dom = new JSDOM("");
    const previous = globalThis.window;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    try {
      const html = renderAssistantMarkdown(
        '<form id="prompt"><button autofocus>Fake</button></form><span data-pf-message="common.deny" style="position:fixed;inset:0">Visible</span>\n\n$x^2$ ![image](/tmp/result.png)',
      );
      const root = dom.window.document.createElement("div");
      setMessageHtml(root, html);
      expect(root.querySelector("form,[id],[data-pf-message],[autofocus]")).toBeNull();
      expect(root.querySelector('span[style="position:fixed;inset:0"]')).toBeNull();
      expect(root.querySelector(".katex [style]")).not.toBeNull();
      expect(root.querySelector("button.message-image-button img")).not.toBeNull();
    } finally {
      globalThis.window = previous;
      dom.window.close();
    }
  });
  test("native error text and additional details remain visible; owned IDs are localized", () => {
    const i18n = createI18n();
    expect(errorText("Native provider error", i18n.t)).toBe("Native provider error");
    expect(errorText({ message: "Native", additionalDetails: "Details" }, i18n.t)).toBe("Native\nDetails");
    expect(errorText({ messageId: "errors.methodNotAllowed", error: "Raw" }, i18n.t)).toBe("Method not allowed");
  });
});
