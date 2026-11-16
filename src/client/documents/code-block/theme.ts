import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
/** Highlight classes use product-aware variables so a theme change never recreates an editor or selection. */
export const documentCodeHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: "var(--pf-code-keyword)" },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--pf-code-string)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--pf-code-number)" },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "var(--pf-code-type)" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--pf-code-function)" },
    { tag: [tags.comment, tags.docComment], color: "var(--pf-code-comment)", fontStyle: "italic" },
    { tag: [tags.propertyName, tags.attributeName], color: "var(--pf-code-property)" },
  ]),
);
export const documentCodeTheme = EditorView.theme({
  "&": { background: "transparent", color: "var(--pf-ink)", fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--mono, ui-monospace, monospace)",
    lineHeight: "1.75",
    overflow: "auto",
    maxHeight: "560px",
  },
  ".cm-content": { padding: "12px 0 16px", caretColor: "var(--pf-ink)" },
  ".cm-line": { padding: "0 16px 0 8px" },
  ".cm-gutters": { background: "transparent", color: "var(--pf-muted)", border: "none", paddingInlineStart: "6px" },
  ".cm-gutterElement": { padding: "0 6px" },
  ".cm-cursor": { borderLeftColor: "var(--pf-ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    background: "color-mix(in srgb,var(--pf-accent) 22%,transparent)",
  },
  ".cm-foldPlaceholder": { background: "var(--pf-soft)", color: "var(--pf-muted)", borderColor: "var(--pf-line)" },
});
