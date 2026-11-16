import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { NativeSlidesDefinition, NativeSlidesProposal, NativeSlidesReview } from "../../shared/slides/registry.js";
import { escapeHtml as e } from "../../shared/html.js";

const field = (t: Translate, name: string, label: MessageId, value: string, pattern = "") =>
  `<label class="wb-field">${e(t(label))}<input data-office-field="${name}" value="${e(value)}" required maxlength="${name === "id" ? 80 : name === "version" ? 20 : name === "publisher" || name === "license" ? 200 : 2000}" ${pattern ? `pattern="${pattern}"` : ""}></label>`;
export function nativeSlidesImportFrame(
  t: Translate,
  proposal: NativeSlidesProposal,
  definition: NativeSlidesDefinition,
) {
  const settings = definition.settings;
  return `<section class="template-source-panel native-slides-import"><h3>${e(t("templates.officeConfigure"))}</h3><p>${e(t("templates.officePrivateHint"))}</p><p>${e(proposal.original.kind.toUpperCase())} · ${e(t("templates.officeLayouts"))}: ${proposal.original.layouts.length} · ${e(t("templates.officeSlides"))}: ${proposal.original.slides.length}</p>
    <form class="wb-form" data-office-settings>${proposal.definition ? `<p>${e(t("templates.officeRetainHint"))}</p><label class="wb-choice office-customize"><input type="checkbox" data-office-customize>${e(t("templates.officeCustomize"))}</label>` : ""}
    <fieldset data-office-definition ${proposal.definition ? "disabled hidden" : ""}><div class="wb-form-grid">${field(t, "id", "templates.draftId", settings.id, "[a-z](?:[a-z0-9.]|-)*")}${field(t, "version", "templates.version", settings.version, "[0-9]+[.][0-9]+[.][0-9]+")}${field(t, "name", "templates.draftName", settings.name.en || "")}${field(t, "publisher", "templates.publisher", settings.publisher)}${field(t, "license", "templates.license", settings.license)}</div>
    ${field(t, "description", "templates.draftDescription", settings.description.en || "")}<label class="wb-field">${e(t("templates.officeLicenseText"))}<textarea rows="4" data-office-field="licenseText" required>${e(definition.licenseText)}</textarea></label><details><summary>${e(t("templates.officeReadmeText"))}</summary><textarea rows="4" data-office-field="readmeText">${e(definition.readmeText)}</textarea></details><div data-office-mapping></div></fieldset>
    <button type="submit" class="wb-button" data-office-review>${e(t("templates.officeReview"))}</button></form><p role="status" data-office-notice></p><div data-office-approval></div></section>`;
}
export function nativeSlidesApprovalFrame(t: Translate, review: NativeSlidesReview) {
  const settings = review.descriptor.manifest.settings;
  return `<div class="package-review"><h4>${e(settings.name.en!)} · ${e(settings.version)}</h4><p>${e(settings.license)}</p><details open><summary>${e(t("templates.officeLicenseText"))}</summary><pre>${e(review.licenseText)}</pre></details><details><summary>${e(t("templates.officeBundleIdentity"))}</summary><code>${e(review.digest)}</code><p>${e(t("templates.officeSourceIdentity"))}</p><code>${e(review.descriptor.manifest.original.sha256)}</code></details><form class="wb-form" data-office-accept><label class="wb-choice office-consent"><input type="checkbox" required data-office-license>${e(t("templates.officeLicenseAcknowledged"))}</label><button class="wb-button primary" type="submit">${e(t("templates.officeInstall"))}</button></form></div>`;
}
