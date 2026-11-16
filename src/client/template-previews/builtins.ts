import manifest from "../../shared/template-previews/builtins.json";
export function includedTemplatePreview(key: string) {
  return manifest.entries.find((entry) => entry.key === key);
}
export const templatePreviewSupported = (item: { templateType: string; reference: { registry: string } }) =>
  item.templateType === "panda.site-theme" && ["builtin", "presentation", "native"].includes(item.reference.registry);
