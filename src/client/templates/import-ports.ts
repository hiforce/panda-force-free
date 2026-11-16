import type { Translate } from "../../shared/i18n/messages.js";

export interface ReviewedTemplateImport {
  approval(t: Translate): string;
  install(operationId: string): Promise<void>;
}
export interface TemplateImportCandidate {
  choices: { key: string; label: string; disabled?: boolean }[];
  review(selected: string[]): Promise<ReviewedTemplateImport>;
}
