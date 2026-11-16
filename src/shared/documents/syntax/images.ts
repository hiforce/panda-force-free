import { Marked, type Token } from "marked";
import type { DocumentEngine } from "../contracts.js";
import { hexoTokenizer, type HexoToken } from "./hexo.js";

/** Discover image references without running engine extensions, MDX or embedded HTML. */
export function documentImageSources(content: string, engine: DocumentEngine): string[] {
  const parser = new Marked(engine === "hexo" ? { extensions: [hexoTokenizer] } : {}),
    result = new Set<string>();
  function walk(tokens: Token[]) {
    for (const token of tokens) {
      if (token.type === "image") result.add(token.href);
      else if (token.type === "code" || token.type === "codespan" || token.type === "html") continue;
      else if (token.type === "pandaHexo") {
        const value = token as HexoToken;
        if (value.closed && value.tag === "figure" && value.args[0]) result.add(value.args[0]);
        if (value.closed && ["figure", "abstract", "thesis", "lead"].includes(value.tag))
          walk(parser.lexer(value.inner));
      } else if (token.type === "list") walk(token.items);
      else if (token.type === "table")
        for (const row of [token.header, ...token.rows]) for (const cell of row) walk(cell.tokens);
      else if ("tokens" in token && Array.isArray(token.tokens)) walk(token.tokens);
    }
  }
  const source = content.replace(/\r\n?/g, "\n").replace(/^\ufeff?---\n[\s\S]*?\n---(?:\n|$)/, "");
  walk(parser.lexer(source));
  return [...result];
}
export const assetContentUrl = (id: string) => `/api/document-assets/content?id=${id}`;
export function resolveDocumentImage(source: string, bindings: readonly { source: string; assetId: string }[] = []) {
  const binding = bindings.find((item) => item.source === source);
  return binding ? assetContentUrl(binding.assetId) : source;
}
