import type { SiteThemeProfile } from "../../presentation/theme-profile.js";
import type { BuildEngine } from "../../builds/engines.js";
import type { PortableTemplateManifest, VerifiedPortableTemplate } from "../portable/contracts.js";
import type { RichDocumentBody } from "../../documents/rich-body.js";
import type { TemplateImage } from "../authoring/images.js";

export interface SiteProfileTemplate {
  kind: "site";
  engine: BuildEngine;
  profile: SiteThemeProfile;
}
export interface DocumentLayoutTemplate {
  kind: "document";
  syntax: "markdown";
  contentSlots: readonly { id: string; kind: "rich-text" | "plain-text"; default: string }[];
  content: string;
  instructions: string;
}
export interface SlidesLayoutTemplate {
  kind: "slides";
  aspectRatio: "16:9" | "4:3" | "9:16" | "1:1";
  theme: { primary: string; background: string; font: "serif" | "sans" };
  layouts: readonly { id: string; slots: readonly string[] }[];
  sampleSlides: readonly { layout: string; values: Readonly<Record<string, string>> }[];
  editableSource: "structured-slides";
}
export interface RichDocumentLayoutTemplate {
  kind: "document";
  syntax: "richtext";
  body: RichDocumentBody;
  images: readonly TemplateImage[];
  contentSlots: DocumentLayoutTemplate["contentSlots"];
  instructions: string;
}
export type PortableTemplateModel =
  SiteProfileTemplate | DocumentLayoutTemplate | RichDocumentLayoutTemplate | SlidesLayoutTemplate;
export interface PortableTemplateTypeAdapter {
  readonly templateType: string;
  readonly format: string;
  readonly adapter: { readonly id: string; readonly api: number };
  parse(value: unknown, manifest: PortableTemplateManifest): PortableTemplateModel;
}
export interface PreparedPortableTemplate {
  readonly template: VerifiedPortableTemplate;
  readonly model: PortableTemplateModel;
}
