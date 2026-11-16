import type { Translate } from "../../shared/i18n/messages.js";
import type { PortableTemplateReview } from "../../shared/templates/portable/registry.js";
import { escapeHtml as e } from "../../shared/html.js";
import { portableSourceLabel } from "./source-labels.js";

export function portableTemplateApproval(t: Translate, review: PortableTemplateReview, prefix = "managedImport") {
  return `<div class="package-review"><p>${e(t("templates.portableImportHint"))}</p><ul>${review.candidates
    .filter((item) => review.selected.includes(item.key))
    .map(
      (item) =>
        `<li>${e(item.manifest.name[document.documentElement.lang] || item.manifest.name.en)} · ${e(item.manifest.version)} · ${e(item.manifest.license.expression)}<br><code>${e(item.digest)}</code></li>`,
    )
    .join("")}</ul>
  <p>${e(portableSourceLabel(review.source))} · <code>${e(review.source.sha256)}</code></p><form id="${prefix}Approval"><label><input type="checkbox" id="${prefix}Accept" required>${e(t("templates.approveSelected"))}</label><button type="submit" class="wb-button primary">${e(t("templates.install"))}</button></form></div>`;
}
