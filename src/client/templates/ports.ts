import type { PortableTemplateModel } from "../../shared/templates/types/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { ManagedTemplate, TemplateRegistry } from "../../shared/templates/catalog.js";

/** A loaded detail owns only this panel's resources; authority stays with its native adapter. */
export interface ManagedTemplateDetail {
  hint?: string;
  apply?(): Promise<void>;
  overview?(target: HTMLElement): Promise<void>;
  preview?(target: HTMLElement): Promise<void>;
  clearPreview?(): void;
  edit?(): Promise<() => void>;
  export?(): Promise<void>;
  setEnabled?(enabled: boolean): Promise<void>;
  activate?(): Promise<void>;
}
export interface TemplateManagerAdapter {
  registry: TemplateRegistry;
  load(template: ManagedTemplate): Promise<ManagedTemplateDetail>;
}

/** Renderers are supplied by the owning lazy runtime; read adapters never import that runtime. */
export interface TemplateDetailPreviewRuntime {
  previewSkill(host: HTMLElement, content: string, title: string): void;
  previewPortable(
    host: HTMLElement,
    model: PortableTemplateModel,
    t: Translate,
    images: ReadonlyMap<string, string>,
  ): void;
}
