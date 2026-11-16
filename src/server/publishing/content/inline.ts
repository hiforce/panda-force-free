import { decodeHTML } from "entities";
import type { Token } from "marked";
import type { Inline } from "../../../shared/publishing/content.js";

/** Translate parser tokens into our own portable inline model. HTML is always literal text. */
export function inlineContent(tokens: Token[] | undefined, fallback = ""): Inline[] {
  if (!tokens?.length) return fallback ? [{ kind: "text", text: decodeHTML(fallback) }] : [];
  return tokens.flatMap((token): Inline[] => {
    switch (token.type) {
      case "strong":
        return [{ kind: "strong", children: inlineContent(token.tokens, token.text) }];
      case "em":
        return [{ kind: "emphasis", children: inlineContent(token.tokens, token.text) }];
      case "del":
        return [{ kind: "strike", children: inlineContent(token.tokens, token.text) }];
      case "link":
        return [{ kind: "link", href: token.href, children: inlineContent(token.tokens, token.text) }];
      case "image":
        return [{ kind: "image", source: token.href, alt: token.text, ...(token.title ? { title: token.title } : {}) }];
      case "codespan":
        return [{ kind: "code", text: token.text }];
      case "br":
        return [{ kind: "break" }];
      case "text":
        return token.tokens
          ? inlineContent(token.tokens, token.text)
          : [{ kind: "text", text: decodeHTML(token.text) }];
      case "escape":
        return [{ kind: "text", text: decodeHTML(token.text) }];
      default:
        return [{ kind: "opaque", text: token.raw }];
    }
  });
}
export function inlineText(inline: Inline[], links = true): string {
  return inline
    .map((item) => {
      switch (item.kind) {
        case "text":
        case "code":
        case "opaque":
          return item.text;
        case "strong":
        case "emphasis":
        case "strike":
        case "underline":
          return inlineText(item.children, links);
        case "link": {
          const label = inlineText(item.children, links);
          return links && label !== item.href ? `${label} (${item.href})` : label;
        }
        case "image":
          return item.alt;
        case "break":
          return "\n";
      }
    })
    .join("");
}
export function safeLink(href: string) {
  return /^(?:https?:\/\/|mailto:)/i.test(href) && ![...href].some((character) => character.charCodeAt(0) < 32);
}
export function unsupportedLink(href: string): "unsafeLink" | "unresolvedLink" {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || [...href].some((character) => character.charCodeAt(0) < 32)
    ? "unsafeLink"
    : "unresolvedLink";
}
