import type { TokenizerExtension, Tokens } from "marked";
export interface HexoToken extends Tokens.Generic {
  type: "pandaHexo";
  tag: string;
  args: string[];
  inner: string;
  closed: boolean;
}
const paired = new Set(["abstract", "thesis", "lead", "figure"]);
function argumentsOf(input: string): string[] {
  const values: string[] = [];
  for (const match of input.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g))
    values.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1"));
  return values;
}
/** Recognize our documented semantic tags without evaluating Hexo helpers or JavaScript. */
export const hexoTokenizer: TokenizerExtension = {
  name: "pandaHexo",
  level: "block",
  start(source) {
    return source.search(/^\{%\s*[a-z]/m);
  },
  tokenizer(source): HexoToken | undefined {
    const opening = source.match(/^\{%\s*([a-z][a-z0-9_-]*)\s*([^\n]*?)\s*%\}[ \t]*(?:\n|$)/i);
    if (!opening) return;
    const tag = opening[1]!.toLowerCase(),
      args = argumentsOf(opening[2] || "");
    let end = opening[0].length,
      inner = "",
      closed = false;
    if (paired.has(tag) || new RegExp(`^\\{%\\s*end${tag}\\s*%\\}`, "m").test(source.slice(end))) {
      let depth = 1,
        cursor = end,
        fence = "";
      for (const line of source.slice(end).matchAll(/[^\n]*(?:\n|$)/g)) {
        if (!line[0]) break;
        const text = line[0],
          fenceMatch = text.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fenceMatch) {
          if (!fence) fence = fenceMatch[1]!;
          else if (fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = "";
        }
        if (!fence) {
          const marker = text.match(/^\{%\s*([a-z][a-z0-9_-]*)\b/i)?.[1]?.toLowerCase();
          if (marker === tag) depth++;
          if (marker === "end" + tag && --depth === 0) {
            inner = source.slice(end, cursor);
            end = cursor + text.length;
            closed = true;
            break;
          }
        }
        cursor += text.length;
      }
    }
    return { type: "pandaHexo", raw: source.slice(0, end), tag, args, inner, closed };
  },
};
