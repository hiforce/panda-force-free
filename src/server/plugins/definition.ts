import type { MetadataStore } from "../../shared/async-value.js";
import { verifyTemplateDefinition } from "../../shared/plugins/library-validation.js";
import type { TemplateLibraryStore } from "./ports.js";
import { PluginRegistryError } from "./errors.js";

export async function readVerifiedTemplateDraft(store: MetadataStore<Pick<TemplateLibraryStore, "get">>, id: string) {
  const value = await store.get(id),
    checked = await verifyTemplateDefinition(value.definition);
  if (checked.digest !== value.digest || checked.packageDigest !== value.packageDigest)
    throw new PluginRegistryError("packageUnavailable");
  return value;
}
