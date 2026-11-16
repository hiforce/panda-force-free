import { Marked, type Token } from "marked";
import type { DocumentEngine, DocumentResourceBinding } from "../../../shared/documents/contracts.js";
import { resolveDocumentImage } from "../../../shared/documents/syntax/images.js";
import { hexoTokenizer, type HexoToken } from "../../../shared/documents/syntax/hexo.js";
import { SiteBuildError } from "../errors.js";

interface Replacement {
  start: number;
  end: number;
  id: string;
  render: (url: string) => string;
}
/** Project immutable image bindings into a build copy, preserving code and the stored source. */
export function buildImageReferences(
  content: string,
  bindings: readonly DocumentResourceBinding[] = [],
  engine: DocumentEngine = "markdown",
) {
  const source = content.replace(/\r\n?/g, "\n"),
    parser = new Marked(engine === "hexo" ? { extensions: [hexoTokenizer] } : {}),
    replacements: Replacement[] = [],
    assets = new Set<string>();
  let engineSpecific = false;
  function asset(source: string) {
    const resolved = resolveDocumentImage(source, bindings);
    if (!resolved.startsWith("/api/document-assets/")) return;
    const id = /^\/api\/document-assets\/content\?id=([a-f0-9-]{36})$/.exec(resolved)?.[1];
    if (!id) throw new SiteBuildError("unsupportedImageReference");
    assets.add(id);
    return id;
  }
  const escaped = (value: string) => value.replace(/([\\[\]"])/g, "\\$1").replace(/[\r\n]/g, " ");
  function walk(tokens: Token[], start: number, end: number) {
    let cursor = start;
    for (const token of tokens) {
      const offset = source.indexOf(token.raw, cursor),
        exact = offset >= cursor && offset + token.raw.length <= end;
      const from = exact ? offset : start,
        to = exact ? offset + token.raw.length : end;
      if (exact) cursor = to;
      if (token.type === "code" || token.type === "codespan") continue;
      if (engine === "docusaurus" && (token.type === "html" || /^(?:import|export)\s|\{[^}]+\}/m.test(token.raw)))
        engineSpecific = true;
      if (token.type === "html") continue;
      if (token.type === "image") {
        const id = asset(token.href);
        if (id) {
          if (!exact) throw new SiteBuildError("unsupportedImageReference");
          replacements.push({
            start: from,
            end: to,
            id,
            render: (url) => `![${escaped(token.text)}](${url}${token.title ? ` "${escaped(token.title)}"` : ""})`,
          });
        }
      } else if (token.type === "pandaHexo") {
        engineSpecific = true;
        const value = token as HexoToken;
        if (value.tag === "figure" && value.closed && value.args[0]) {
          const id = asset(value.args[0]);
          if (id) {
            const header = /^(\{%\s*figure\s+)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/i.exec(value.raw);
            if (!exact || !header) throw new SiteBuildError("unsupportedImageReference");
            replacements.push({
              start: from + header[1]!.length,
              end: from + header[0].length,
              id,
              render: (url) => JSON.stringify(url),
            });
          }
        }
        if (value.closed && ["figure", "abstract", "thesis", "lead"].includes(value.tag)) {
          const inner = source.indexOf(value.inner, from + value.raw.indexOf("%}") + 2);
          if (!exact || inner < from || inner + value.inner.length > to)
            throw new SiteBuildError("unsupportedImageReference");
          walk(parser.lexer(value.inner), inner, inner + value.inner.length);
        }
      } else if (token.type === "list") walk(token.items, from, to);
      else if (token.type === "table") {
        for (const row of [token.header, ...token.rows]) for (const cell of row) walk(cell.tokens, from, to);
      } else if ("tokens" in token && Array.isArray(token.tokens)) walk(token.tokens, from, to);
    }
  }
  const frontmatter = source.match(/^\ufeff?---\n[\s\S]*?\n---(?:\n|$)/)?.[0].length || 0;
  walk(parser.lexer(source.slice(frontmatter)), frontmatter, source.length);
  return {
    engineSpecific,
    assets: [...assets],
    rewrite(urls: ReadonlyMap<string, string>) {
      let result = source;
      const used = new Set<string>();
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        const key = `${replacement.start}:${replacement.end}`;
        if (used.has(key)) continue;
        used.add(key);
        const url = urls.get(replacement.id);
        if (!url) throw new SiteBuildError("assetUnavailable");
        result = result.slice(0, replacement.start) + replacement.render(url) + result.slice(replacement.end);
      }
      return result;
    },
  };
}
