import type { ManagedTemplate } from "./catalog.js";

export type TemplateDomain = "skills" | "publishing";
export const publishingTemplateTypes: readonly string[] = ["panda.site-theme", "panda.channel-format"];

/** Native identity and payload type determine resource ownership; user labels never do. */
export function isPublishingTemplate(item: Pick<ManagedTemplate, "reference" | "templateType">): boolean {
  return (
    item.reference.kind === "site-theme" ||
    item.reference.kind === "channel-template" ||
    publishingTemplateTypes.includes(item.templateType)
  );
}

export function templateInDomain(item: ManagedTemplate, domain: TemplateDomain): boolean {
  return isPublishingTemplate(item) === (domain === "publishing");
}
