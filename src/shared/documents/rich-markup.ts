import type { RichDocumentBody, RichTextNode } from "./rich-body.js";
import { richImageId, richLink } from "./rich-body.js";
import { escapeHtml } from "../html.js";

export class RichMarkupError extends Error {}
/** Closed HTML/JSX projection preserves rich semantics without sending editor JSON or executable user text to a worker. */
export function richMarkup(
  body: RichDocumentBody,
  dialect: "html" | "jsx",
  images: ReadonlyMap<string, string>,
): string {
  const jsx = dialect === "jsx",
    literal = (value: string) =>
      JSON.stringify(value)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029"),
    html = (value: string | number) => escapeHtml(value).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;"),
    text = (value: string) => (jsx ? `{${literal(value)}}` : html(value)),
    attribute = (name: string, value: string | number) =>
      jsx ? ` ${name}={${literal(String(value))}}` : ` ${name}="${html(value)}"`,
    align = (value: unknown) =>
      ["left", "center", "right", "justify"].includes(String(value))
        ? jsx
          ? ` style={{textAlign:${literal(String(value))}}}`
          : ` style="text-align:${value}"`
        : "";
  function visit(node: RichTextNode): string {
    const children = () => (node.content || []).map(visit).join(""),
      attrs = node.attrs || {};
    switch (node.type) {
      case "doc":
        return children();
      case "text": {
        let value = text(node.text || "");
        for (const mark of node.marks || []) {
          if (mark.type === "link")
            value = `<a${attribute("href", richLink(mark.attrs?.href))}${mark.attrs?.title ? attribute("title", String(mark.attrs.title)) : ""} rel="noopener noreferrer nofollow">${value}</a>`;
          else {
            const tag = { bold: "strong", italic: "em", underline: "u", strike: "del", code: "code" }[mark.type];
            if (!tag) throw new RichMarkupError("unsupportedMark");
            value = `<${tag}>${value}</${tag}>`;
          }
        }
        return value;
      }
      case "paragraph":
        return `<p${align(attrs.textAlign)}>${children() || "<br />"}</p>`;
      case "heading": {
        const level = Number(attrs.level);
        if (!Number.isInteger(level) || level < 1 || level > 6) throw new RichMarkupError("unsupportedNode");
        return `<h${level}${align(attrs.textAlign)}>${children()}</h${level}>`;
      }
      case "hardBreak":
        return "<br />";
      case "horizontalRule":
        return "<hr />";
      case "blockquote":
        return `<blockquote>${children()}</blockquote>`;
      case "codeBlock":
        return `<pre><code${attrs.language ? attribute(jsx ? "className" : "class", "language-" + attrs.language) : ""}>${children()}</code></pre>`;
      case "bulletList":
      case "taskList":
        return `<ul>${children()}</ul>`;
      case "orderedList":
        return `<ol${attribute("start", Number(attrs.start || 1))}${attrs.type ? attribute("type", String(attrs.type)) : ""}>${children()}</ol>`;
      case "listItem":
        return `<li>${children()}</li>`;
      case "taskItem":
        return `<li><input type="checkbox" disabled${attrs.checked ? " checked" : ""} />${children()}</li>`;
      case "table":
        return `<table><tbody>${children()}</tbody></table>`;
      case "tableRow":
        return `<tr>${children()}</tr>`;
      case "tableHeader":
      case "tableCell": {
        const tag = node.type === "tableHeader" ? "th" : "td",
          span =
            attribute(jsx ? "colSpan" : "colspan", Number(attrs.colspan || 1)) +
            attribute(jsx ? "rowSpan" : "rowspan", Number(attrs.rowspan || 1)),
          width = Array.isArray(attrs.colwidth)
            ? attrs.colwidth.reduce((sum: number, value) => sum + Number(value), 0)
            : 0;
        return `<${tag}${span}${width ? attribute("width", width) : ""}${align(attrs.align)}>${children()}</${tag}>`;
      }
      case "image": {
        const url = images.get(richImageId(attrs.src));
        if (!url) throw new RichMarkupError("missingImage");
        return `<img${attribute("src", url)}${attribute("alt", String(attrs.alt || ""))}${attribute("title", String(attrs.title || ""))}${attrs.width ? attribute("width", Number(attrs.width)) : ""}${attrs.height ? attribute("height", Number(attrs.height)) : ""} />`;
      }
      default:
        throw new RichMarkupError("unsupportedNode");
    }
  }
  return `<div>\n${visit(body.document)}\n</div>\n`;
}
