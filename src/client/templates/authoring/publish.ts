import type { Translate } from "../../../shared/i18n/messages.js";
import type { TemplateDraftRecord } from "../../../shared/templates/authoring/contracts.js";
import { escapeHtml as e } from "../../../shared/html.js";
import type { DocumentModal } from "../../documents/modal.js";
import { DocumentApiError } from "../../documents/api.js";
import { PluginApiError } from "../../plugins/api.js";
import { templateAuthoringApi as api } from "./api.js";

/** Releasing a reviewed template version is separate from saving a mutable draft or publishing a project article. */
export async function reviewTemplateVersion(
  t: Translate,
  modal: DocumentModal,
  draft: TemplateDraftRecord,
  changed: () => void,
) {
  const review = await api.review(draft),
    operationId = crypto.randomUUID(),
    manifest = draft.manifest;
  return modal.form(
    t("templates.publishVersion"),
    `<p>${e(t("templates.releaseHint"))}</p><p><strong>${e(manifest.name[document.documentElement.lang] || manifest.name.en)}</strong> · ${e(manifest.version)} · ${e(manifest.license.expression)}</p><p><code>${e(draft.digest)}</code></p><label><input type="checkbox" name="document-approve" data-template-release-approve required>${e(t("templates.approveTemplateVersion"))}</label>`,
    t("templates.publishVersion"),
    async (fields) => {
      if (!fields.approve) throw new DocumentApiError(400, { messageId: "plugins.approvalRequired" });
      try {
        const result = await api.publish(draft, review, operationId);
        changed();
        return result;
      } catch (error) {
        if (error instanceof PluginApiError) throw new DocumentApiError(error.status, error.payload);
        throw error;
      }
    },
  );
}
