import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createComposerDrafts } from "../../src/client/composer-drafts.js";
test("legacy new-task draft migrates once and stays isolated between projects", () => {
  const dom = new JSDOM("", { url: "https://fixture.test" }),
    old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  try {
    localStorage.setItem(
      "panda-force-composer-drafts",
      JSON.stringify({
        __new__: {
          text: "Unsent before upgrade",
          mentions: [],
          attachments: [{ name: "01 产品图.png", status: "ready" }],
        },
      }),
    );
    let project = "alpha",
      text = "";
    const drafts = createComposerDrafts({
      getActiveThreadId: () => null,
      getNewDraftKey: () => "__new__:" + project,
      getDraftSnapshot: () => ({ text, mentions: [], attachments: [] }),
    });
    expect(drafts.getComposerDraft()?.text).toBe("Unsent before upgrade");
    expect(drafts.getComposerDraft()?.attachments[0].name).toBe("01 产品图.png");
    project = "beta";
    expect(drafts.getComposerDraft()).toBeUndefined();
    text = "Beta only";
    drafts.persistComposerDraft();
    project = "alpha";
    expect(drafts.getComposerDraft()?.text).toBe("Unsent before upgrade");
  } finally {
    if (old) Object.defineProperty(globalThis, "localStorage", old);
    else delete globalThis.localStorage;
    dom.window.close();
  }
});
test("a completed session cannot clear a different project's new-session draft", () => {
  const dom = new JSDOM("", { url: "https://fixture.test" }),
    old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  try {
    let project = "alpha",
      text = "Alpha unsent";
    const drafts = createComposerDrafts({
      getActiveThreadId: () => null,
      getNewDraftKey: () => "__new__:project:" + project + ":/same-folder",
      getDraftSnapshot: () => ({ text, mentions: [], attachments: [] }),
    });
    drafts.persistComposerDraft();
    project = "beta";
    text = "Beta unsent";
    drafts.persistComposerDraft();
    drafts.clearComposerDraft("native-alpha");
    expect(drafts.getComposerDraft()?.text).toBe("Beta unsent");
    project = "alpha";
    expect(drafts.getComposerDraft()?.text).toBe("Alpha unsent");
  } finally {
    if (old) Object.defineProperty(globalThis, "localStorage", old);
    else delete globalThis.localStorage;
    dom.window.close();
  }
});

test("persistent input recall is lazy, coalesced, paged and retryable after a failed read", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  let release: ((response: Response) => void) | undefined;
  globalThis.fetch = ((url) => {
    urls.push(String(url));
    return new Promise((resolve) => {
      release = resolve;
    });
  }) as typeof fetch;
  try {
    const drafts = createComposerDrafts({
      getActiveThreadId: () => null,
      getDraftSnapshot: () => ({ text: "", mentions: [], attachments: [] }),
    });
    expect(urls).toHaveLength(0);
    const first = drafts.loadComposerHistory();
    expect(drafts.loadComposerHistory()).toBe(first);
    release!(Response.json({ entries: [{ text: "recent" }], nextCursor: "older-page" }));
    await first;
    expect(drafts.composerHistory.navigate(-1, "", 0)?.text).toBe("recent");
    const failed = drafts.loadComposerHistory();
    release!(Response.json({}, { status: 503 }));
    await expect(failed).rejects.toThrow();
    const retry = drafts.loadComposerHistory();
    release!(Response.json({ entries: [{ text: "earlier" }], nextCursor: null }));
    await retry;
    expect(drafts.composerHistory.navigate(-1, "recent", 6)?.text).toBe("earlier");
    expect(urls[0]).toBe("/api/composer/history?limit=20");
    expect(urls[1]).toContain("cursor=older-page");
    expect(urls[2]).toBe(urls[1]);
    await drafts.loadComposerHistory();
    expect(urls).toHaveLength(3);
  } finally {
    globalThis.fetch = original;
  }
});

test("input recall skips an empty filtered page without declaring older history exhausted", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () =>
    Response.json(
      ++calls === 1
        ? { entries: [], nextCursor: "older" }
        : { entries: [{ text: "Authorized older input" }], nextCursor: null },
    )) as typeof fetch;
  try {
    const drafts = createComposerDrafts({
      getActiveThreadId: () => null,
      getDraftSnapshot: () => ({ text: "", mentions: [], attachments: [] }),
    });
    await drafts.loadComposerHistory();
    expect(calls).toBe(2);
    expect(drafts.composerHistory.navigate(-1, "", 0)?.text).toBe("Authorized older input");
  } finally {
    globalThis.fetch = original;
  }
});
