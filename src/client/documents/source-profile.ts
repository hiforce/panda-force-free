import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentSpace } from "../../shared/documents/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";
import { DocumentApiError } from "./api.js";
import { legacyDocumentSpaces, type DocumentSpaceApi } from "./space-api.js";
import { field } from "./views.js";
import type { DocumentModal } from "./modal.js";

/** Import is a proposal, not execution: public settings are reviewed before the space version changes. */
export class SourceProfileDialog {
  constructor(
    private t: Translate,
    private modal: DocumentModal,
    private spaces: DocumentSpaceApi = legacyDocumentSpaces,
  ) {}
  async open(space: DocumentSpace) {
    const request = this.modal.generation,
      t = this.t;
    const [data, options] = await Promise.all([
      this.spaces.sourceProfile(space.id),
      this.spaces.sourceOptions(space.id),
    ]);
    if (request !== this.modal.generation) return null;
    const pending = this.modal.form(
      t("documents.sourceSettings"),
      `<p>${m("documents.sourceSettingsHint", undefined, t)}</p>${field(t, "documents.locale", "locale", space.locale, 'required maxlength="35"')}<fieldset class="source-profile-files"><legend>${m("documents.sourceConfigFiles", undefined, t)}</legend>${options.files.map((file, index) => `<label><input type="checkbox" name="document-config-${index}" value="${e(file)}"><code>${e(file)}</code></label>`).join("")}</fieldset><label class="source-profile-choice"><input type="checkbox" name="document-webp" ${data.profile?.imageMode === "source-webp" ? "checked" : ""}>${m("documents.sourceWebp", undefined, t)}</label><p>${m("documents.sourceWebpHint", undefined, t)}</p>${data.profile ? `<label class="source-profile-choice"><input type="checkbox" name="document-existing">${m("documents.sourceEditExisting", undefined, t)}</label>` : ""}`,
      t("documents.sourceReview"),
      async (fields) => {
        if (fields.existing && data.profile)
          return { profile: data.profile, omitted: [], spaceVersion: data.space.version };
        return this.spaces.inspectSourceProfile(
          space.id,
          fields.locale!,
          options.files.filter((_, index) => fields[`config-${index}`]),
          Boolean(fields.webp),
        );
      },
    );
    const generation = this.modal.generation,
      proposal = await pending;
    if (!proposal || this.modal.generation !== generation + 1) return null;
    return this.modal.form(
      t("documents.sourceReview"),
      `<p>${m("documents.sourceReviewHint", undefined, t)}</p>${proposal.omitted.length ? `<details class="source-profile-omitted"><summary>${m("documents.sourceOmitted", undefined, t)}</summary><ul>${proposal.omitted.map((path) => `<li><code>${e(path)}</code></li>`).join("")}</ul></details>` : ""}<label for="doc-profile">${m("documents.sourcePublicProfile", undefined, t)}</label><textarea id="doc-profile" name="document-profile" class="source-profile-json" rows="18" maxlength="131072" spellcheck="false" required>${e(JSON.stringify(proposal.profile, null, 2))}</textarea><p>${m("documents.sourceRescanHint", undefined, t)}</p>`,
      t("documents.save"),
      async (fields) => {
        let value: unknown;
        try {
          value = JSON.parse(fields.profile!);
        } catch {
          throw new DocumentApiError(400, { messageId: "documents.invalidSourceConfiguration" });
        }
        return (await this.spaces.saveSourceProfile(space.id, proposal.spaceVersion, value)).space;
      },
    );
  }
}
