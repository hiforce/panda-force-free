import { escapeHtml as e } from "../../../shared/html.js";
import type { ContentBlock, ContentIR, ContentImage, Inline } from "../../../shared/publishing/content.js";
import { inlineText, safeLink, unsupportedLink } from "./inline.js";

export { templates, type TemplateName } from "../../../shared/presentation/templates.js";
import { templateDescriptor, type TemplateSelection } from "../../../shared/presentation/templates.js";
export function plainBlock(block: ContentBlock): string {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return inlineText(block.inline);
    case "code":
      return block.text;
    case "image":
      return block.alt;
    case "quote":
      return block.children
        .map(plainBlock)
        .join("\n\n")
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    case "list":
      return block.items
        .map(
          (item, index) =>
            `${block.ordered ? block.start + index + "." : "•"} ${item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] "}${item.children.map(plainBlock).join("\n")}`,
        )
        .join("\n");
    case "table":
      return [block.header, ...block.rows].map((row) => row.map((cell) => inlineText(cell)).join(" | ")).join("\n");
    case "grid":
      return block.rows
        .map((row) => row.map((cell) => cell.children.map(plainBlock).join("\n")).join(" | "))
        .join("\n");
    case "rule":
      return "———";
    case "opaque":
      return block.raw.trim();
    case "container":
      return [block.title, block.image?.alt || "", ...block.children.map(plainBlock)].filter(Boolean).join("\n\n");
  }
}
/** All output markup is generated here; no source HTML or arbitrary template CSS is evaluated. */
export function renderContent(
  ir: ContentIR,
  template: TemplateSelection,
  imageUrl: (source: string) => string | null = (source) =>
    /^\/api\/document-assets\/content\?id=[a-f0-9-]{36}$/.test(source) ? source : null,
) {
  const theme = templateDescriptor(template).style;
  const alignment = (value: unknown) =>
    ["left", "center", "right", "justify"].includes(String(value)) ? `text-align:${value};` : "";
  const image = (source: string, alt: string, properties: Partial<ContentImage> = {}) => {
    const resolved = imageUrl(source);
    return resolved
      ? `<figure style="margin:24px 0"><img src="${e(resolved)}" alt="${e(alt)}"${properties.title ? ` title="${e(properties.title)}"` : ""}${properties.width ? ` width="${e(properties.width)}"` : ""}${properties.height ? ` height="${e(properties.height)}"` : ""} style="max-width:100%;height:auto;border-radius:8px">${alt ? `<figcaption style="font:13px/1.6 Arial,sans-serif;color:#687083">${e(alt)}</figcaption>` : ""}</figure>`
      : `<p style="font:13px/1.7 Arial,sans-serif;color:#687083">${e(alt)}${source ? ` (${e(source)})` : ""}</p>`;
  };
  const inline = (items: Inline[]): string =>
    items
      .map((item) => {
        switch (item.kind) {
          case "text":
          case "opaque":
            return e(item.text);
          case "code":
            return `<code style="font:14px/1.7 monospace;background:#f1f2f6;padding:2px 4px;border-radius:3px">${e(item.text)}</code>`;
          case "strong":
            return `<strong>${inline(item.children)}</strong>`;
          case "emphasis":
            return `<em>${inline(item.children)}</em>`;
          case "strike":
            return `<s>${inline(item.children)}</s>`;
          case "underline":
            return `<u>${inline(item.children)}</u>`;
          case "link":
            return safeLink(item.href)
              ? `<a href="${e(item.href)}" target="_blank" rel="noopener noreferrer" style="color:${theme.accent};text-decoration:underline">${inline(item.children)}</a>`
              : inline(item.children) + (unsupportedLink(item.href) === "unresolvedLink" ? ` (${e(item.href)})` : "");
          case "image":
            return image(item.source, item.alt, item);
          case "break":
            return "<br>";
        }
      })
      .join("");
  const render = (block: ContentBlock): string => {
    switch (block.kind) {
      case "paragraph":
        return `<p style="margin:18px 0;line-height:1.85${block.align ? `;${alignment(block.align)}` : ""}">${inline(block.inline)}</p>`;
      case "heading": {
        const level = Math.max(1, Math.min(6, block.level));
        return `<h${level} style="font-family:Arial,sans-serif;font-size:${level === 1 ? 30 : level === 2 ? 24 : 19}px;line-height:1.4;margin:30px 0 16px;color:${theme.color}${block.align ? `;${alignment(block.align)}` : ""}">${inline(block.inline)}</h${level}>`;
      }
      case "code":
        return `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f8;border:1px solid #e6e7ec;padding:18px;border-radius:8px;font:13px/1.75 monospace"><code>${e(block.text)}</code></pre>`;
      case "quote":
        return `<blockquote style="margin:22px 0;padding:2px 18px;border-left:3px solid ${theme.accent};color:#576075">${block.children.map(render).join("")}</blockquote>`;
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag}${block.ordered ? ` start="${block.start}"${block.style ? ` type="${e(block.style)}"` : ""}` : ""} style="padding-left:24px">${block.items.map((item) => `<li>${item.checked === undefined ? "" : item.checked ? "☑ " : "☐ "}${item.children.map(render).join("")}</li>`).join("")}</${tag}>`;
      }
      case "image":
        return image(block.source, block.alt, block);
      case "grid":
        return `<div style="max-width:100%;overflow-x:auto"><table style="border-collapse:collapse;width:100%;font:14px/1.7 Arial,sans-serif"><tbody>${block.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell) => {
                  const tag = cell.header ? "th" : "td",
                    width = cell.colwidth?.reduce((sum, value) => sum + value, 0);
                  return `<${tag} colspan="${cell.colspan}" rowspan="${cell.rowspan}"${width ? ` width="${width}"` : ""} style="border:1px solid #dfe2ea;padding:8px;${alignment(cell.align)}">${cell.children.map(render).join("")}</${tag}>`;
                })
                .join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`;
      case "table":
        return `<table style="border-collapse:collapse;width:100%;font:14px/1.7 Arial,sans-serif"><thead><tr>${block.header.map((cell) => `<th style="text-align:left;border:1px solid #dfe2ea;padding:8px">${inline(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td style="border:1px solid #dfe2ea;padding:8px">${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "rule":
        return '<hr style="border:0;border-top:1px solid #dfe2ea;margin:30px 0">';
      case "opaque":
        return `<pre style="white-space:pre-wrap;font:13px/1.7 monospace;border:1px dashed #bbc0cd;padding:16px">${e(block.raw)}</pre>`;
      case "container":
        return `<section${block.role === "thesis" || block.role === "abstract" ? ` style="padding:16px 20px;border-left:3px solid ${theme.accent};background:#f7f8fb;margin:24px 0"` : ""}>${block.title ? `<h2 style="font:600 18px/1.5 Arial,sans-serif">${e(block.title)}</h2>` : ""}${block.image ? image(block.image.source, block.image.alt) : ""}${block.children.map(render).join("")}</section>`;
    }
  };
  return {
    text: [ir.title, ...ir.blocks.map(plainBlock)].join("\n\n"),
    html: `<article lang="${e(ir.locale)}" style="max-width:${theme.width};margin:auto;color:${theme.color};font-family:${theme.font};font-size:${theme.size};line-height:1.85;overflow-wrap:anywhere"><h1 style="font:650 32px/1.3 Arial,sans-serif;margin:0 0 28px">${e(ir.title)}</h1>${ir.blocks.map(render).join("")}</article>`,
  };
}
