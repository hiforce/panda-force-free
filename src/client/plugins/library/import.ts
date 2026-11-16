import { TEMPLATE_LIBRARY_LIMITS, type TemplateDefinition } from "../../../shared/plugins/library.js";
import { PluginApiError } from "../api.js";

/** Archive decoding is independent of dialog readiness and keeps the selected File's immutable content. */
export async function readTemplateLibraryArchive(file: File): Promise<TemplateDefinition> {
  if (file.size > TEMPLATE_LIBRARY_LIMITS.jsonBytes)
    throw new PluginApiError(413, { messageId: "plugins.packageTooLarge" });
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new PluginApiError(400, { messageId: "plugins.invalidLibraryDraft" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PluginApiError(400, { messageId: "plugins.invalidLibraryDraft" });
  const raw = value as Record<string, unknown>,
    definition = (raw.definition || (raw.package && raw.archive && raw.fixtures && raw)) as
      TemplateDefinition | undefined;
  if (!definition) throw new PluginApiError(400, { messageId: "plugins.invalidLibraryDraft" });
  return definition;
}
