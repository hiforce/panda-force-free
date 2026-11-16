import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { bindDocumentEditorHost } from "../../src/client/documents/editor-bindings.js";

function fixture() {
  const dom = new JSDOM(
      '<section><textarea id="documentTitle"></textarea><div class="document-rich-shell"><div contenteditable="true"></div></div><details class="document-editor-more" open><summary>More</summary><button data-doc-action="save"><span>Save</span></button></details></section>',
    ),
    host = dom.window.document.querySelector("section")!,
    signal = new dom.window.AbortController(),
    calls: string[] = [],
    errors: unknown[] = [];
  let reject = false;
  bindDocumentEditorHost(host, signal.signal, {
    capture() {
      calls.push("capture");
    },
    async save() {
      calls.push("save");
    },
    focus() {
      calls.push("focus");
    },
    async action(name) {
      calls.push("action:" + name);
      if (reject) throw Error("rejected");
    },
    error(error) {
      errors.push(error);
    },
  });
  return {
    dom,
    host,
    signal,
    calls,
    errors,
    reject() {
      reject = true;
    },
    close() {
      signal.abort();
      dom.window.close();
    },
  };
}

test("shared editor title handling preserves composition and leaves rich-body capture to the editor runtime", () => {
  const f = fixture();
  try {
    const title = f.host.querySelector("textarea")!;
    title.value = "First\nSecond";
    title.dispatchEvent(new f.dom.window.Event("input", { bubbles: true }));
    expect(title.value).toBe("First Second");
    expect(f.calls).toEqual(["capture"]);
    f.host.querySelector("[contenteditable]")!.dispatchEvent(new f.dom.window.Event("input", { bubbles: true }));
    expect(f.calls).toEqual(["capture"]);
    const enter = new f.dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    title.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(f.calls).toEqual(["capture"]);
    const done = new f.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    title.dispatchEvent(done);
    expect(done.defaultPrevented).toBe(true);
    expect(f.calls.at(-1)).toBe("focus");
  } finally {
    f.close();
  }
});

test("editor save shortcuts and nested menu controls share one dispatch and stop after unmount", () => {
  const f = fixture();
  try {
    const shortcut = new f.dom.window.KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    f.host.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(f.calls).toEqual(["save"]);
    const button = f.host.querySelector("button")!;
    button.disabled = true;
    button.querySelector("span")!.dispatchEvent(new f.dom.window.Event("click", { bubbles: true }));
    expect(f.calls).toEqual(["save"]);
    button.disabled = false;
    button.querySelector("span")!.dispatchEvent(new f.dom.window.Event("click", { bubbles: true }));
    expect(f.calls).toEqual(["save", "action:save"]);
    expect(f.host.querySelector("details")!.open).toBe(false);
    f.signal.abort();
    button.dispatchEvent(new f.dom.window.Event("click", { bubbles: true }));
    f.host.dispatchEvent(shortcut);
    expect(f.calls).toEqual(["save", "action:save"]);
    expect(f.errors).toEqual([]);
  } finally {
    f.close();
  }
});

test("editor action rejection is reported without leaking an unhandled asynchronous operation", async () => {
  const f = fixture();
  try {
    f.reject();
    f.host.querySelector("span")!.dispatchEvent(new f.dom.window.Event("click", { bubbles: true }));
    await Promise.resolve();
    expect(f.errors).toHaveLength(1);
    expect((f.errors[0] as Error).message).toBe("rejected");
  } finally {
    f.close();
  }
});
