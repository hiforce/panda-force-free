import { contentSourceScope } from "../../../shared/publishing/source-scope.js";
import { createHash } from "node:crypto";
import { Marked, type Token, type Tokens } from "marked";
import type {
  ContentIR,
  ContentBlock,
  ContentIssue,
  BlockOrigin,
  SourceSpan,
  Inline,
} from "../../../shared/publishing/content.js";
import { resolveDocumentImage } from "../../../shared/documents/syntax/images.js";
import { hexoTokenizer, type HexoToken } from "./hexo.js";
import { inlineContent, safeLink, unsupportedLink } from "./inline.js";
import { parseRichContent } from "./rich.js";
import type { ContentSource } from "./source-contract.js";
export type { ContentSource } from "./source-contract.js";
/** Parsing preserves opaque syntax and source ranges; no renderer or engine hooks run here. */
export function parseContent(input: ContentSource): ContentIR {
  if (input.body) return parseRichContent(input, input.body);
  const source = input.content.replace(/\r\n?/g, "\n");
  const frontmatter = source.match(/^\ufeff?---\n[\s\S]*?\n---(?:\n|$)/)?.[0] || "";
  const parser = new Marked(input.engine === "hexo" ? { extensions: [hexoTokenizer] } : {});
  const issues: ContentIssue[] = [];
  let sequence = 0;
  const issue = (blockId: string, code: ContentIssue["code"], severity: ContentIssue["severity"] = "warning") => {
    if (!issues.some((issue) => issue.blockId === blockId && issue.code === code))
      issues.push({ blockId, code, severity });
  };
  function checkInline(items: Inline[], id: string) {
    for (const item of items) {
      if (item.kind === "opaque") issue(id, "opaqueSyntax");
      if (item.kind === "link" && !safeLink(item.href)) {
        const code = unsupportedLink(item.href);
        issue(id, code, code === "unsafeLink" ? "blocking" : "warning");
      }
      if (item.kind === "image") item.source = resolveDocumentImage(item.source, input.resources);
      if (item.kind === "image" && !/^\/api\/document-assets\/content\?id=[a-f0-9-]{36}$/.test(item.source))
        issue(id, "externalImage");
      if ("children" in item) checkInline(item.children, id);
    }
  }
  function convert(tokens: Token[], parent: SourceSpan): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    let cursor = parent.start;
    for (const token of tokens) {
      const start = source.indexOf(token.raw, cursor);
      const exact = parent.exact && start >= cursor && start + token.raw.length <= parent.end;
      const span = exact ? { start, end: start + token.raw.length, exact: true } : { ...parent, exact: false };
      if (exact) cursor = span.end;
      const origin: BlockOrigin = { id: `${input.revisionId}:b${++sequence}`, raw: token.raw, span };
      let block: ContentBlock;
      switch (token.type) {
        case "space":
        case "def":
          continue;
        case "heading":
          block = { ...origin, kind: "heading", level: token.depth, inline: inlineContent(token.tokens, token.text) };
          break;
        case "paragraph":
        case "text":
          if (
            input.engine === "docusaurus" &&
            /^(?:import\s.+\sfrom\s['"]|import\s*['"]|export\s+(?:const|default|function)\b)/m.test(token.raw)
          )
            block = { ...origin, kind: "opaque", syntax: "mdx" };
          else block = { ...origin, kind: "paragraph", inline: inlineContent(token.tokens, token.text) };
          break;
        case "code":
          block = { ...origin, kind: "code", language: token.lang || "", text: token.text };
          break;
        case "blockquote":
          block = { ...origin, kind: "quote", children: convert((token as Tokens.Blockquote).tokens, span) };
          break;
        case "list": {
          let itemCursor = span.start;
          block = {
            ...origin,
            kind: "list",
            ordered: token.ordered,
            start: typeof token.start === "number" ? token.start : 1,
            items: (token as Tokens.List).items.map((item) => {
              const itemStart = source.indexOf(item.raw, itemCursor);
              const itemExact = span.exact && itemStart >= itemCursor && itemStart + item.raw.length <= span.end;
              const itemSpan = itemExact
                ? { start: itemStart, end: itemStart + item.raw.length, exact: true }
                : { ...span, exact: false };
              if (itemExact) itemCursor = itemSpan.end;
              return {
                ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
                children: convert(item.tokens, itemSpan),
              };
            }),
          };
          break;
        }
        case "table":
          block = {
            ...origin,
            kind: "table",
            header: (token as Tokens.Table).header.map((cell) => inlineContent(cell.tokens, cell.text)),
            rows: (token as Tokens.Table).rows.map((row) => row.map((cell) => inlineContent(cell.tokens, cell.text))),
            align: token.align,
          };
          break;
        case "hr":
          block = { ...origin, kind: "rule" };
          break;
        case "pandaHexo": {
          const hexo = token as HexoToken;
          if (hexo.tag === "part")
            block = { ...origin, kind: "heading", level: 2, inline: [{ kind: "text", text: hexo.args.join(" ") }] };
          else if (["abstract", "thesis", "lead", "figure"].includes(hexo.tag) && hexo.closed) {
            const innerStart = source.indexOf(hexo.inner, span.start);
            const childSpan =
              innerStart >= span.start && innerStart + hexo.inner.length <= span.end
                ? { start: innerStart, end: innerStart + hexo.inner.length, exact: span.exact }
                : { ...span, exact: false };
            block = {
              ...origin,
              kind: "container",
              role: hexo.tag as "abstract" | "thesis" | "lead" | "figure",
              title: hexo.tag === "abstract" ? hexo.args.join(" ") : "",
              ...(hexo.tag === "figure"
                ? {
                    image: {
                      source: resolveDocumentImage(hexo.args[0] || "", input.resources),
                      alt: hexo.args[1] || "",
                    },
                  }
                : {}),
              children: convert(parser.lexer(hexo.inner), childSpan),
            };
            if (block.image && !/^\/api\/document-assets\/content\?id=[a-f0-9-]{36}$/.test(block.image.source))
              issue(origin.id, "externalImage");
          } else block = { ...origin, kind: "opaque", syntax: "hexo" };
          break;
        }
        default:
          block = { ...origin, kind: "opaque", syntax: token.type === "html" ? "html" : "markdown" };
      }
      if (block.kind === "opaque") issue(origin.id, "opaqueSyntax");
      if ("inline" in block) checkInline(block.inline, origin.id);
      if (block.kind === "table")
        for (const cells of [block.header, ...block.rows]) for (const cell of cells) checkInline(cell, origin.id);
      blocks.push(block);
    }
    return blocks;
  }
  const blocks = convert(parser.lexer(source.slice(frontmatter.length)), {
    start: frontmatter.length,
    end: source.length,
    exact: true,
  });
  return {
    schema: 1,
    documentId: input.documentId,
    revisionId: input.revisionId,
    ...contentSourceScope(input),
    sourceHash: createHash("sha256").update(input.content).digest("hex"),
    title: input.title,
    locale: input.locale,
    source,
    frontmatter,
    blocks,
    issues,
  };
}
