import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SkillInstallReview } from "../../shared/skills/registry.js";
import type { SkillCapability } from "../../shared/skills/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";

const capabilityNames: Record<SkillCapability, MessageId> = {
  "project.documents.read": "skills.readDocuments",
  "project.documents.create": "skills.createDocuments",
  "project.documents.propose-update": "skills.proposeChanges",
  "project.assets.read": "skills.readAssets",
  "research.web": "skills.webResearch",
  "generate.image": "skills.generateImages",
  "generate.slides": "skills.generateSlides",
  "generate.video": "skills.generateVideo",
  "generate.web": "skills.generateWeb",
};
export function skillApproval(t: Translate, review: SkillInstallReview) {
  return `<div class="package-review"><h3>${e(review.manifest.name[document.documentElement.lang] || review.manifest.name.en)}</h3><p>${e(review.manifest.publisher.name)} · ${e(review.manifest.license.expression)} · ${e(review.manifest.version)}</p><h4>${e(t("templates.permissions"))}</h4><ul>${review.capabilities.map((item) => `<li>${e(t(capabilityNames[item]))}</li>`).join("") || `<li>${e(t("common.none"))}</li>`}</ul><form id="managedImportApproval"><label><input type="checkbox" id="managedImportAccept" required>${e(t("templates.approveSelected"))}</label><button type="submit" class="wb-button primary">${e(t("templates.install"))}</button></form></div>`;
}
