import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "MutationObserver"])
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
// This isolated model test does not run browser focus/scroll work; browser suites exercise those lifecycles.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const { Editor } = await import("@tiptap/core"),
  { MarkdownManager } = await import("@tiptap/markdown"),
  { documentEditorExtensions } = await import("../../src/shared/documents/editor-schema.ts"),
  { runBlockAction, blockActionAvailable } = await import("../../src/client/documents/block-actions.ts");
const paragraph = (text = "Preserve this source") => ({
  type: "paragraph",
  content: [{ type: "text", text, marks: [{ type: "bold" }] }],
});
const targets = {
  paragraph: paragraph(),
  heading: { type: "heading", attrs: { level: 2 }, content: paragraph().content },
  codeBlock: { type: "codeBlock", content: [{ type: "text", text: "Preserve this source" }] },
  blockquote: { type: "blockquote", content: [paragraph(), paragraph("Keep the second paragraph")] },
  bulletList: {
    type: "bulletList",
    content: [
      { type: "listItem", content: [paragraph()] },
      { type: "listItem", content: [paragraph("Keep the second item")] },
    ],
  },
  orderedList: {
    type: "orderedList",
    content: [
      { type: "listItem", content: [paragraph()] },
      { type: "listItem", content: [paragraph("Keep the second item")] },
    ],
  },
  taskList: {
    type: "taskList",
    content: [
      { type: "taskItem", attrs: { checked: true }, content: [paragraph()] },
      { type: "taskItem", attrs: { checked: false }, content: [paragraph("Keep the second item")] },
    ],
  },
};
let cases = 0;
for (const [kind, node] of Object.entries(targets)) {
  for (const action of [
    "paragraph",
    "heading1",
    "heading2",
    "heading3",
    "bulletList",
    "orderedList",
    "blockquote",
    "codeBlock",
  ]) {
    const element = document.createElement("div");
    document.body.append(element);
    const extensions = documentEditorExtensions(),
      markdown = new MarkdownManager({ extensions });
    const editor = new Editor({
      element,
      extensions,
      injectCSS: false,
      content: { type: "doc", content: [node, paragraph("Neighbor stays.")] },
    });
    try {
      const before = editor.getJSON(),
        neighbor = before.content.at(-1),
        text = editor.state.doc.textContent.replace(/\n/g, ""),
        target = { position: 0, node: editor.state.doc.child(0) };
      editor.commands.setNodeSelection(0);
      assert.equal(blockActionAvailable(editor, target, action), true);
      await runBlockAction(editor, target, action, markdown);
      const result = editor.getJSON(),
        expected = action.startsWith("heading") ? "heading" : action;
      assert.equal(result.content[0].type, expected, `${kind} must become ${action} as a complete block`);
      assert.ok(
        result.content.slice(0, -1).every((block) => block.type === expected),
        `${kind} -> ${action} left old containers: ${result.content.map((node) => node.type).join(",")}`,
      );
      if (expected === "heading") assert.equal(result.content[0].attrs.level, Number(action.slice(-1)));
      assert.equal(editor.state.doc.textContent.replace(/\n/g, ""), text, `${kind} -> ${action} changed source text`);
      assert.deepEqual(result.content.at(-1), neighbor, "Conversion changed the neighboring block");
      if (JSON.stringify(result) !== JSON.stringify(before)) {
        assert.equal(editor.commands.undo(), true);
        assert.deepEqual(editor.getJSON(), before, "A whole-block conversion must undo in one step");
      }
      cases++;
    } finally {
      editor.destroy();
      element.remove();
    }
  }
}
const image = {
    type: "image",
    attrs: { src: "/api/document-assets/content?id=00000000-0000-4000-8000-000000000001", alt: "Fixture" },
  },
  table = { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph()] }] }] };
let unsupported = 0;
for (const node of [image, table, { type: "blockquote", content: [paragraph(), image] }]) {
  const element = document.createElement("div"),
    extensions = documentEditorExtensions(),
    markdown = new MarkdownManager({ extensions });
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions,
    injectCSS: false,
    content: { type: "doc", content: [node, paragraph("Neighbor stays.")] },
  });
  try {
    const target = { position: 0, node: editor.state.doc.child(0) },
      before = editor.getJSON();
    for (const action of ["paragraph", "heading1", "bulletList", "orderedList", "blockquote", "codeBlock"]) {
      assert.equal(
        blockActionAvailable(editor, target, action),
        false,
        "A text conversion must not flatten complex content",
      );
      await runBlockAction(editor, target, action, markdown);
      assert.deepEqual(editor.getJSON(), before);
    }
    assert.equal(blockActionAvailable(editor, target, "duplicate"), true);
    unsupported++;
  } finally {
    editor.destroy();
    element.remove();
  }
}
dom.window.close();
console.log(JSON.stringify({ cases, unsupported, textPreserved: true, neighborsPreserved: true, undo: true }));
