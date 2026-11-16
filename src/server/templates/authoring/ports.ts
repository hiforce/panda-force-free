import type { VerifiedPortableTemplate } from "../../../shared/templates/portable/contracts.js";
import type {
  TemplateDraftRecord,
  TemplateDraftAcknowledgement,
  DocumentTemplateDefinition,
} from "../../../shared/templates/authoring/contracts.js";
import type { TemplateImage } from "../../../shared/templates/authoring/images.js";

export interface TemplateImageContent {
  image: TemplateImage;
  bytes: Uint8Array;
}
export interface TemplateImageStore {
  bind(actor: string, draft: string, image: TemplateImage): void;
  get(actor: string, draft: string, id: string): TemplateImage;
}
export interface TemplateImageFiles {
  put(content: TemplateImageContent): Promise<void>;
  read(image: TemplateImage): Promise<Uint8Array>;
}
export interface TemplateImageDecoder {
  decode(input: Uint8Array): Promise<TemplateImageContent>;
}
export interface TemplateImageReader {
  read(image: TemplateImage): Promise<Uint8Array>;
}

export interface TemplateDraftMutation {
  actor: string;
  operationId: string;
  request: string;
  id: string;
  expectedRevision: number;
  now: number;
}
export interface TemplateDraftStore {
  list(actor: string): TemplateDraftRecord[];
  read(actor: string, id: string): TemplateDraftRecord;
  prove(actor: string, id: string, revision: number, digest: string): void;
  replay(actor: string, operationId: string, request: string): TemplateDraftAcknowledgement | null;
  save(template: VerifiedPortableTemplate, mutation: TemplateDraftMutation): TemplateDraftAcknowledgement;
  remove(mutation: TemplateDraftMutation): TemplateDraftAcknowledgement;
}
export interface TemplateDocumentCodec {
  fromMarkdown(value: string): DocumentTemplateDefinition["body"];
  normalize(value: unknown): DocumentTemplateDefinition["body"];
}
export interface TemplateDraftAuthoringAdapter {
  readonly templateType: string;
  supports(template: VerifiedPortableTemplate): boolean;
  create(input: unknown, images?: TemplateImageReader): Promise<VerifiedPortableTemplate>;
  fork(template: VerifiedPortableTemplate, version: string): Promise<VerifiedPortableTemplate>;
  edit(
    template: VerifiedPortableTemplate,
    input: unknown,
    images?: TemplateImageReader,
  ): Promise<VerifiedPortableTemplate>;
  definition(template: VerifiedPortableTemplate): DocumentTemplateDefinition;
}
