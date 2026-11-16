import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM(
  '<!doctype html><body><button id="edit">Edit</button><input id="title"><div id="root"></div></body>',
  { url: "http://fixture.test" },
);
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const { RichDocumentSurface } = await import("../../src/client/documents/rich-surface.ts");
const { RuntimeLoadError } = await import("../../src/client/documents/runtime-loader.ts");
const { normalizeRichBody } = await import("../../src/shared/documents/rich-body.ts");
const id = "12345678-1234-1234-1234-123456789abc",
  literal = "<script>window.compromised=true</script> {literal}";
const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] }),
  body = normalizeRichBody({
    schema: 1,
    format: "richtext",
    document: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, textAlign: "center" },
          content: [{ type: "text", text: literal, marks: [{ type: "bold" }, { type: "underline" }] }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Link", marks: [{ type: "link", attrs: { href: "https://example.test/?q=hello" } }] },
            { type: "hardBreak" },
            { type: "text", text: "Code", marks: [{ type: "code" }] },
          ],
        },
        { type: "blockquote", content: [paragraph("Quoted")] },
        {
          type: "codeBlock",
          attrs: { language: "js" },
          content: [{ type: "text", text: 'const value = "<script>";' }],
        },
        {
          type: "orderedList",
          attrs: { start: 3, type: "a" },
          content: [{ type: "listItem", content: [paragraph("Third item")] }],
        },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("Checked task")] }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colspan: 2, rowspan: 2, colwidth: [120, 140], align: "right" },
                  content: [paragraph("Merged")],
                },
              ],
            },
          ],
        },
        {
          type: "image",
          attrs: {
            src: "/api/document-assets/content?id=" + id,
            alt: 'Owned "picture"',
            title: "Original.png",
            width: 48,
            height: 36,
          },
        },
        { type: "horizontalRule" },
      ],
    },
  }),
  content = "\n  Exact historical **projection**.\n\n",
  t = (id) => id,
  settled = () => new Promise((resolve) => setImmediate(resolve));
const root = document.querySelector("#root");
function host() {
  const h = document.createElement("div");
  root.append(h);
  return h;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function options(extra = {}) {
  return {
    body,
    content,
    t,
    editable: false,
    changed() {},
    error(e) {
      throw e;
    },
    upload: async () => {
      throw Error("No upload expected");
    },
    link: async () => null,
    ready() {},
    ...extra,
  };
}
function fakeRuntime() {
  const stats = { created: 0, destroyed: 0, focus: 0, inserted: [], modes: [] };
  let node;
  return {
    stats,
    get node() {
      return node;
    },
    module: {
      createRichDocumentEditor(h, o) {
        stats.created++;
        node = document.createElement("div");
        node.tabIndex = 0;
        node.className = "document-rich-content";
        node.contentEditable = "true";
        h.replaceChildren(node);
        return {
          snapshot: () => ({ body, content }),
          uploading: false,
          setEditable(value) {
            stats.modes.push(value);
          },
          focus() {
            stats.focus++;
            node.focus();
          },
          insertMarkdown(value) {
            stats.inserted.push(value);
          },
          openInsertMenu() {},
          destroy() {
            stats.destroyed++;
            h.replaceChildren();
          },
        };
      },
    },
  };
}
try {
  const h = host(),
    ready = deferred(),
    load = deferred(),
    runtime = fakeRuntime();
  let loads = 0;
  const view = new RichDocumentSurface(h, options({ ready: ready.resolve }), () => {
    loads++;
    return load.promise;
  });
  assert.equal(loads, 0);
  assert.equal(view.ready, false);
  assert.equal(view.snapshot().body, body);
  assert.equal(view.snapshot().content, content);
  assert.equal(h.querySelector("script"), null);
  assert.equal(h.querySelector("h2").textContent, literal);
  assert.equal(h.querySelector("h2").style.textAlign, "center");
  assert.equal(h.querySelector("h2 strong").textContent, literal);
  assert.equal(h.querySelector("h2 u").textContent, literal);
  assert.equal(h.querySelector("a").getAttribute("href"), "https://example.test/?q=hello");
  assert.equal(h.querySelector("ol").start, 3);
  assert.equal(h.querySelector("ol").type, "a");
  assert.equal(h.querySelector("input[type=checkbox]").checked, true);
  assert.equal(h.querySelector("input[type=checkbox]").disabled, true);
  assert.equal(h.querySelector("ul").dataset.type, "taskList");
  assert.equal(h.querySelector("td").colSpan, 2);
  assert.equal(h.querySelector("td").rowSpan, 2);
  assert.equal(h.querySelector("td").getAttribute("width"), "260");
  assert.equal(h.querySelector("td").style.textAlign, "right");
  assert.equal(h.querySelector("img").getAttribute("src"), "/api/document-assets/content?id=" + id);
  assert.equal(h.querySelector("img").width, 48);
  assert.equal(h.querySelector("img").height, 36);
  assert.equal(h.querySelector("img").title, "Original.png");
  const reader = h.querySelector("[data-document-reader]");
  view.setEditable(true);
  document.querySelector("#edit").focus();
  view.focus();
  const insertion = view.insertMarkdown("Additional");
  document.querySelector("#title").focus();
  assert.equal(h.querySelector("[data-document-reader]"), reader);
  assert.equal(view.snapshot().content, content);
  load.resolve(runtime.module);
  await ready.promise;
  await insertion;
  assert.equal(runtime.stats.focus, 0);
  assert.equal(document.activeElement.id, "title");
  assert.equal(loads, 1);
  assert.equal(runtime.stats.created, 1);
  assert.deepEqual(runtime.stats.inserted, ["Additional"]);
  const editor = runtime.node;
  view.setEditable(false);
  view.setEditable(true);
  await settled();
  assert.equal(runtime.node, editor);
  assert.equal(runtime.stats.created, 1);
  view.destroy();
  assert.equal(runtime.stats.destroyed, 1);
  const held = deferred(),
    cancelRuntime = fakeRuntime(),
    cancelHost = host(),
    cancel = new RichDocumentSurface(cancelHost, options(), () => held.promise);
  cancel.setEditable(true);
  const cancelled = cancel.insertMarkdown("Cancelled");
  cancel.setEditable(false);
  assert.equal(cancelHost.getAttribute("aria-busy"), null);
  held.resolve(cancelRuntime.module);
  await cancelled;
  assert.equal(cancelRuntime.stats.created, 0);
  assert.ok(cancelHost.querySelector("[data-document-reader]"));
  cancel.destroy();
  const disposedLoad = deferred(),
    disposedRuntime = fakeRuntime(),
    disposed = new RichDocumentSurface(host(), options(), () => disposedLoad.promise);
  disposed.setEditable(true);
  const old = disposed.insertMarkdown("Stale");
  disposed.destroy();
  disposedLoad.resolve(disposedRuntime.module);
  await old;
  assert.equal(disposedRuntime.stats.created, 0);
  const retryRuntime = fakeRuntime(),
    retryReady = deferred();
  let retryCalls = 0;
  const retryHost = host(),
    retry = new RichDocumentSurface(retryHost, options({ ready: retryReady.resolve }), async () => {
      if (!retryCalls++) throw new RuntimeLoadError("transfer", true, Error("network"));
      return retryRuntime.module;
    });
  retry.setEditable(true);
  await settled();
  assert.ok(retryHost.querySelector("[data-document-reader]"));
  assert.equal(retryHost.querySelector("[role=alert] span").textContent, "documents.editorLoadFailed");
  retryHost.querySelector("[role=alert] button").click();
  await retryReady.promise;
  assert.equal(retryCalls, 2);
  assert.equal(retryRuntime.stats.created, 1);
  retry.destroy();
  const badHost = host();
  let creations = 0;
  const bad = new RichDocumentSurface(badHost, options(), async () => ({
    createRichDocumentEditor(h) {
      creations++;
      h.replaceChildren();
      throw Error("Factory failed");
    },
  }));
  bad.setEditable(true);
  await settled();
  assert.ok(badHost.querySelector("[data-document-reader]"));
  assert.equal(badHost.querySelector("[role=alert] span").textContent, "documents.editorStartFailed");
  assert.equal(badHost.querySelector("[role=alert] button"), null);
  bad.setEditable(false);
  bad.setEditable(true);
  await settled();
  assert.equal(creations, 1);
  bad.destroy();
  console.log(
    JSON.stringify({
      passed: true,
      reader: true,
      draftProjection: true,
      cancellation: true,
      disposal: true,
      focus: true,
      retry: true,
      initializationFencing: true,
    }),
  );
} finally {
  dom.window.close();
}
