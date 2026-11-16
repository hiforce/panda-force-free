import type { Inline, PublicationFormat } from "./content.js";

type InlineStyle = Extract<Inline["kind"], "strong" | "emphasis" | "strike" | "underline" | "code">;
interface RichCapabilities {
  inlineStyles: Readonly<Record<InlineStyle, boolean>>;
  imageLayout: boolean;
  alignment: boolean;
  listStyle: boolean;
  grid: boolean;
}
export interface PublicationFormatCapabilities {
  composition: "document" | "post" | "thread" | "article";
  representation: "html" | "text";
  delivery: "post" | "article" | null;
  rich: Readonly<RichCapabilities>;
}
const plain: Readonly<RichCapabilities> = {
  inlineStyles: { strong: false, emphasis: false, strike: false, underline: false, code: false },
  imageLayout: false,
  alignment: false,
  listStyle: false,
  grid: false,
};
const html: Readonly<RichCapabilities> = {
  inlineStyles: { strong: true, emphasis: true, strike: true, underline: true, code: true },
  imageLayout: true,
  alignment: true,
  listStyle: true,
  grid: true,
};
const article: Readonly<RichCapabilities> = {
  ...plain,
  inlineStyles: { ...plain.inlineStyles, strong: true, emphasis: true, strike: true },
};
/** Describes the implemented serializers; composition and external publication remain separate. */
export const PUBLICATION_FORMAT_CAPABILITIES: Readonly<Record<PublicationFormat, PublicationFormatCapabilities>> = {
  html: { composition: "document", representation: "html", delivery: null, rich: html },
  plain: { composition: "document", representation: "text", delivery: null, rich: plain },
  wechat: { composition: "document", representation: "html", delivery: null, rich: html },
  toutiao: { composition: "document", representation: "html", delivery: null, rich: html },
  "x-post": { composition: "post", representation: "text", delivery: "post", rich: plain },
  "x-thread": { composition: "thread", representation: "text", delivery: "post", rich: plain },
  "x-article": { composition: "article", representation: "text", delivery: "article", rich: article },
};
export function publicationFormatCapabilities(format: unknown): PublicationFormatCapabilities | null {
  return typeof format === "string" && Object.hasOwn(PUBLICATION_FORMAT_CAPABILITIES, format)
    ? PUBLICATION_FORMAT_CAPABILITIES[format as PublicationFormat]
    : null;
}
export function preservesPublicationInlineStyle(capabilities: RichCapabilities, kind: Inline["kind"]) {
  return !Object.hasOwn(capabilities.inlineStyles, kind) || capabilities.inlineStyles[kind as InlineStyle];
}
