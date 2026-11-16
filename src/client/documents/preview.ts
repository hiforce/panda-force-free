import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../../shared/html.js";
import type { DocumentEngine, DocumentResourceBinding } from "../../shared/documents/contracts.js";
import { hexoTokenizer, type HexoToken } from "../../shared/documents/syntax/hexo.js";
import { resolveDocumentImage } from "../../shared/documents/syntax/images.js";
import { sanitizeRichText } from "../html-safety.js";

/** Each preview owns its image bindings. MDX, raw HTML and unknown engine tags remain inert. */
export function documentPreview(
  content: string,
  engine: DocumentEngine = "markdown",
  bindings: DocumentResourceBinding[] = [],
  imageUrl: (id: string) => string = (id) => "/api/document-assets/content?id=" + id,
): string {
  const image = (href: string, text: string) => {
    const url = resolveDocumentImage(href, bindings);
    return /^\/api\/document-assets\/content\?id=[a-f0-9-]{36}$/.test(url)
      ? `<img src="${escapeHtml(imageUrl(url.split("=")[1]!))}" alt="${escapeHtml(text)}" loading="lazy">`
      : `<span class="document-image-label">${escapeHtml(text)}</span>`;
  };
  const markdown: Marked = new Marked({
    ...(engine === "hexo"
      ? {
          extensions: [
            {
              ...hexoTokenizer,
              renderer(token: Tokens.Generic): string {
                const value = token as HexoToken;
                if (value.tag === "part") return `<h2>${escapeHtml(value.args.join(" "))}</h2>`;
                if (!value.closed || !["abstract", "thesis", "lead", "figure"].includes(value.tag))
                  return `<pre>${escapeHtml(value.raw)}</pre>`;
                const body = markdown.parse(value.inner, { async: false });
                return value.tag === "figure"
                  ? `<figure>${image(value.args[0] || "", value.args[1] || "")}<figcaption>${body}</figcaption></figure>`
                  : `<section class="document-${value.tag}">${value.tag === "abstract" && value.args.length ? `<h3>${escapeHtml(value.args.join(" "))}</h3>` : ""}${body}</section>`;
              },
            },
          ],
        }
      : {}),
    renderer: {
      html: ({ text }) => escapeHtml(text),
      image: ({ href, text }) => image(href, text),
      link({ href, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (!/^https?:\/\//i.test(href)) return label;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      },
    },
  });
  return sanitizeRichText(markdown.parse(content, { async: false }));
}
