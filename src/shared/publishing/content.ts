import type { TemplateSnapshot } from "../presentation/template-snapshot.js";
import type { RichDocumentBody } from "../documents/rich-body.js";
import type { ContentSourceScope } from "./source-scope.js";
/** Channel-neutral content keeps source provenance; platform DTOs belong to adapters. */
export interface SourceSpan {
  start: number;
  end: number;
  exact: boolean;
}
export type Inline =
  | { kind: "text" | "code" | "opaque"; text: string }
  | { kind: "strong" | "emphasis" | "strike" | "underline"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | ({ kind: "image" } & ContentImage)
  | { kind: "break" };
export interface BlockOrigin {
  id: string;
  span: SourceSpan;
  /** Exact Markdown text, or an explicitly generated adapter fallback. Rich paths identify canonical source. */
  raw: string;
  /** Path in the immutable canonical rich body. Markdown offsets are never exact for rich sources. */
  richPath?: number[];
}
export interface ContentImage {
  source: string;
  alt: string;
  title?: string;
  width?: number;
  height?: number;
}
export type ContentAlignment = "left" | "center" | "right" | "justify";
export interface ContentGridCell {
  header: boolean;
  colspan: number;
  rowspan: number;
  colwidth?: number[];
  align?: ContentAlignment;
  children: ContentBlock[];
}
export type ContentBlock = BlockOrigin &
  (
    | { kind: "heading"; level: number; inline: Inline[]; align?: ContentAlignment }
    | { kind: "paragraph"; inline: Inline[]; align?: ContentAlignment }
    | { kind: "code"; language: string; text: string }
    | { kind: "quote"; children: ContentBlock[] }
    | {
        kind: "list";
        ordered: boolean;
        start: number;
        style?: "1" | "a" | "A" | "i" | "I";
        items: { checked?: boolean; children: ContentBlock[] }[];
      }
    | { kind: "table"; header: Inline[][]; rows: Inline[][][]; align: ("left" | "center" | "right" | null)[] }
    | { kind: "grid"; rows: ContentGridCell[][] }
    | ({ kind: "image" } & ContentImage)
    | { kind: "rule" }
    | {
        kind: "container";
        role: "abstract" | "thesis" | "lead" | "figure";
        title: string;
        image?: { source: string; alt: string };
        children: ContentBlock[];
      }
    | { kind: "opaque"; syntax: "html" | "mdx" | "hexo" | "markdown" }
  );
export interface ContentIssue {
  code:
    | "opaqueSyntax"
    | "unsafeLink"
    | "unresolvedLink"
    | "externalImage"
    | "unsupportedStyle"
    | "structuredTextFlattened"
    | "splitIntoPosts"
    | "imageNeedsUpload"
    | "articleMarkdownLimit"
    | "postImageLimit"
    | "invalidPost";
  severity: "info" | "warning" | "blocking";
  blockId: string;
}
export interface ContentIR extends ContentSourceScope {
  schema: 1;
  documentId: string;
  revisionId: string;
  sourceHash: string;
  title: string;
  locale: string;
  /** Markdown exchange text. Only exact spans identify source text; rich edits address the canonical body. */
  source: string;
  origin?: { kind: "richtext"; body: RichDocumentBody };
  frontmatter: string;
  blocks: ContentBlock[];
  issues: ContentIssue[];
}
export type PublicationFormat = "html" | "plain" | "x-post" | "x-thread" | "x-article" | "wechat" | "toutiao";
export type ContentMode = "format" | "proofread" | "summary" | "rewrite";
export interface VariantSource extends ContentSourceScope {
  documentId: string;
  revisionId: string;
  sourceHash: string;
}
export interface ContentVariant {
  schema: 1;
  id: string;
  source: VariantSource;
  format: PublicationFormat;
  mode: ContentMode;
  templateId: string;
  templateVersion: string;
  templateDigest?: string;
  templateSnapshot?: TemplateSnapshot;
  formatterVersion: string;
  title: string;
  locale: string;
  text: string;
  html: string;
  images?: { source: string; alt: string; blockId: string }[];
  posts: { text: string; weightedLength: number; valid: boolean; sourceBlockIds: string[]; imageIndexes?: number[] }[];
  issues: ContentIssue[];
  createdAt: number;
}
export interface ProofreadingSuggestion {
  id: string;
  span: SourceSpan;
  before: string;
  after: string;
  rule: "trailingWhitespace" | "repeatedSpaces";
  blockId: string;
}
