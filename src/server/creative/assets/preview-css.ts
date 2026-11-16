import { tokenizer, TokenType, type CSSToken } from "./vendor/css-tokenizer.js";

/** CSS syntax is decoded by the shared standards tokenizer; only URL-bearing tokens are rewritten. */
export function rewritePreviewCss(css: string, resolve: (value: string, stylesheet: boolean) => string): string {
  const reader = tokenizer({ css }),
    output: string[] = [],
    functions: string[] = [];
  let imported = false,
    count = 0;
  const next = (): CSSToken => {
    if (++count > 250000) throw new RangeError("Preview CSS token limit");
    return reader.nextToken();
  };
  const whitespace = (token: CSSToken) => token[0] === TokenType.Whitespace || token[0] === TokenType.Comment;
  for (let token = next(); token[0] !== TokenType.EOF; token = next()) {
    if (token[0] === TokenType.AtKeyword) {
      imported = token[4].value.toLowerCase() === "import";
      output.push(token[1]);
      continue;
    }
    if (whitespace(token)) {
      output.push(token[1]);
      continue;
    }
    if (token[0] === TokenType.URL) output.push("url(" + JSON.stringify(resolve(token[4].value, imported)) + ")");
    else if (
      token[0] === TokenType.String &&
      (imported || ["image-set", "-webkit-image-set"].includes(functions.at(-1) ?? ""))
    )
      output.push(JSON.stringify(resolve(token[4].value, imported)));
    else if (token[0] === TokenType.Function && token[4].value.toLowerCase() === "url") {
      const raw = [token[1]];
      let value = next();
      while (whitespace(value)) {
        raw.push(value[1]);
        value = next();
      }
      raw.push(value[1]);
      let end = next();
      while (whitespace(end)) {
        raw.push(end[1]);
        end = next();
      }
      raw.push(end[1]);
      output.push(
        value[0] === TokenType.String && end[0] === TokenType.CloseParen
          ? "url(" + JSON.stringify(resolve(value[4].value, imported)) + ")"
          : raw.join(""),
      );
    } else {
      if (token[0] === TokenType.Function || token[0] === TokenType.OpenParen) {
        functions.push(token[0] === TokenType.Function ? token[4].value.toLowerCase() : "");
        if (functions.length > 128) throw new RangeError("Preview CSS function depth");
      } else if (token[0] === TokenType.CloseParen) functions.pop();
      output.push(token[1]);
    }
    imported = false;
  }
  return output.join("");
}
