import type { TemplateCatalogSourceSnapshot, TemplateRegistry } from "../../shared/templates/catalog.js";

/** Each native registry owns its revision and lifecycle. The manager does not mirror that authority. */
export interface TemplateCatalogSource {
  registry: TemplateRegistry;
  read(actor?: string): Promise<TemplateCatalogSourceSnapshot>;
}
