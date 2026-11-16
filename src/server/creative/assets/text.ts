import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { CreativeAssetKind } from "../../../shared/creative/assets.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { NativePresentation } from "../../slides/office/package.js";
import { PRESENTATION_NAMESPACES } from "../../slides/office/namespaces.js";
import { xmlDescendants, type XmlElement } from "../../packages/opc/xml.js";
import { DocumentError } from "../../documents/errors.js";

export interface CreativeText {
  text: string;
  sections: { id: string; start: number; end: number }[];
  previewHtml?: string;
}
function assemble(parts: { id: string; text: string }[]): CreativeText {
  const pieces: string[] = [];
  let characters = 0,
    bytes = 0;
  const sections: CreativeText["sections"] = [];
  for (const part of parts) {
    if (pieces.length) {
      pieces.push("\n\n");
      characters += 2;
      bytes += 2;
    }
    const start = characters;
    pieces.push(part.text);
    characters += part.text.length;
    bytes += Buffer.byteLength(part.text);
    if (bytes > limits.textBytes) throw new DocumentError("tooLarge", 413);
    sections.push({ id: part.id, start, end: characters });
  }
  return { text: pieces.join(""), sections };
}
function htmlText(bytes: Uint8Array) {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    document = parse(html),
    excluded = new Set(["script", "style", "template", "noscript", "head", "iframe", "object"]),
    blocks = new Set([
      "p",
      "div",
      "article",
      "section",
      "main",
      "li",
      "ul",
      "ol",
      "tr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "pre",
      "blockquote",
    ]);
  const fragments: string[] = [];
  let count = 0;
  const visit = (node: DefaultTreeAdapterMap["node"], depth: number) => {
    if (++count > 100000 || depth > 128) throw new DocumentError("tooLarge", 413);
    if (
      "tagName" in node &&
      (excluded.has(node.tagName) ||
        node.attrs.some((a) => a.name === "hidden" || (a.name === "aria-hidden" && a.value === "true")))
    )
      return;
    if ("value" in node && node.nodeName === "#text") fragments.push(node.value);
    if ("tagName" in node && ["br", "td", "th"].includes(node.tagName)) fragments.push("\n");
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, depth + 1);
    if ("tagName" in node && blocks.has(node.tagName)) fragments.push("\n");
  };
  visit(document, 0);
  return assemble([
    {
      id: "web-body",
      text: fragments
        .join("")
        .replace(/[\t\r ]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    },
  ]);
}
/** Pure parsers never run scripts, resolve URLs or read external relationship targets. Native bytes remain authoritative. */
export async function creativeText(kind: CreativeAssetKind, name: string, bytes: Uint8Array): Promise<CreativeText> {
  if (bytes.length > (kind === "web" ? limits.htmlBytes : limits.sourceBytes)) throw new DocumentError("tooLarge", 413);
  if (kind === "web") return htmlText(bytes);
  const presentation = await NativePresentation.open(bytes, name);
  if (presentation.index.kind !== "pptx") throw new DocumentError("invalidInput");
  const ns = PRESENTATION_NAMESPACES.find((n) => n.dialect === presentation.index.dialect)!;
  return assemble(
    presentation.index.slides.map((slide, i) => {
      const root = presentation.parts.xml(slide.path).documentElement!;
      const text = xmlDescendants(root, ns.a, "p")
        .map((p) =>
          Array.from(p.childNodes)
            .map((node) => {
              if (node.nodeType !== 1) return "";
              const child = node as XmlElement;
              if (child.namespaceURI !== ns.a) return "";
              if (child.localName === "br") return "\n";
              if (child.localName === "r" || child.localName === "fld")
                return xmlDescendants(child, ns.a, "t")
                  .map((n) => n.textContent ?? "")
                  .join("");
              return "";
            })
            .join(""),
        )
        .join("\n");
      return { id: "slide-" + (i + 1), text };
    }),
  );
}
