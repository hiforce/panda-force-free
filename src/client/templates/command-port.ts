import type { Translate } from "../../shared/i18n/messages.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import type { PluginPackage } from "../../shared/plugins/contracts.js";
import type { TemplateDetailPreviewRuntime } from "./ports.js";
export interface TemplateCommandCallbacks {
  applySkill?: (selection: import("../../shared/creation/contracts.js").CreationSkillSelection) => void;
  refresh(): void;
  notice(message: string, failed?: boolean): void;
  creationStatus(busy: boolean): void;
}
export interface TemplateCommands {
  readonly creating: boolean;
  run(action: string, item?: ManagedTemplate): Promise<void>;
  editPresentation(draft: PluginPackage): void;
  close(): void;
}
export interface TemplateCommandRuntime extends TemplateDetailPreviewRuntime {
  prepareWritingEditor(): void;
  createTemplateCommands(
    t: Translate,
    identity: string | undefined,
    callbacks: TemplateCommandCallbacks,
  ): TemplateCommands;
}
