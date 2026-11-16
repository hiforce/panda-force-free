import type { ManagedTemplate } from "./catalog.js";

export const templateSections = ["writing", "research", "slides", "image", "web", "video", "site", "channel"] as const;
export type TemplateSection = (typeof templateSections)[number];

/** Classification is shared by catalog queries and navigation; it never changes native authority. */
export function templateInSection(item: ManagedTemplate, section: TemplateSection): boolean {
  if (section === "site") return item.templateType === "panda.site-theme";
  if (section === "channel") return item.templateType === "panda.channel-format";
  if (["panda.site-theme", "panda.channel-format"].includes(item.templateType)) return false;
  if (item.reference.registry === "skills") return item.categories.includes(section);
  if (section === "research") return item.categories.includes("research");
  const output = section === "writing" ? "document" : section;
  return (
    item.compatibility.outputs.includes(output) ||
    (section === "writing" && item.templateType === "panda.document-template") ||
    (section === "slides" && item.templateType === "panda.slides-template")
  );
}
