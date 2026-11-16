import type { PortableTemplateManifest } from "../portable/contracts.js";
import type { TemplateParameter, LocalizedTemplateText } from "../portable/contracts.js";
import type { RichDocumentBody } from "../../documents/rich-body.js";
import type { RichDocumentLayoutTemplate } from "../types/contracts.js";
import type { TemplateImage } from "./images.js";

export interface TemplateDraftRecord {
  id: string;
  owner: string;
  revision: number;
  digest: string;
  manifest: PortableTemplateManifest;
  createdAt: number;
  updatedAt: number;
  removed: boolean;
}
export interface TemplateDraftAcknowledgement {
  operationId: string;
  id: string;
  revision: number;
  digest: string;
  removed: boolean;
}
export interface DocumentTemplateDefinition {
  id: string;
  version: string;
  name: LocalizedTemplateText;
  description: LocalizedTemplateText;
  publisher: { name: string; homepage?: string };
  license: { expression: string; text: string };
  categories: readonly string[];
  tags: readonly string[];
  parameters: readonly TemplateParameter[];
  contentSlots: RichDocumentLayoutTemplate["contentSlots"];
  instructions: string;
  body: RichDocumentBody;
  images: readonly TemplateImage[];
}
export interface TemplateDraftDetail {
  draft: TemplateDraftRecord;
  definition: DocumentTemplateDefinition;
}
export interface TemplateDraftResult {
  acknowledgement: TemplateDraftAcknowledgement;
  current: TemplateDraftDetail | null;
}
