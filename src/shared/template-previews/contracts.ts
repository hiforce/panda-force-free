import type { SupportedLocale } from "../i18n/contracts.js";
export const TEMPLATE_PREVIEW_RENDERER = "template-preview/v1-chromium-1248";
export const TEMPLATE_PREVIEW_VIEWS = ["home", "article", "mobile"] as const;
export type TemplatePreviewView = (typeof TEMPLATE_PREVIEW_VIEWS)[number];
export type TemplatePreviewPhase = "queued" | "building" | "rendering" | "ready" | "failed";
export interface TemplatePreviewJob {
  id: string;
  key: string;
  templateKey: string;
  locale: SupportedLocale;
  phase: TemplatePreviewPhase;
  createdAt: number;
  updatedAt: number;
  generation: number;
  attempts: number;
  failure: "buildFailed" | "renderUnavailable" | "previewUnavailable" | null;
  images: Partial<Record<TemplatePreviewView, { sha256: string; width: number; height: number; bytes: number }>>;
}
export interface TemplatePreviewInput {
  schema: 1;
  renderer: typeof TEMPLATE_PREVIEW_RENDERER;
  locale: SupportedLocale;
  home: string;
  article: string;
}
export interface TemplatePreviewRaster {
  schema: 1;
  renderer: typeof TEMPLATE_PREVIEW_RENDERER;
  images: Record<TemplatePreviewView, { png: string; width: number; height: number }>;
}
