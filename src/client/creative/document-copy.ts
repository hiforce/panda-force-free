import type { DocumentRecord } from "../../shared/documents/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { documentJson, DocumentApiError } from "../documents/api.js";
import type { DocumentModal } from "../documents/modal.js";
import { messageHtml } from "../i18n.js";

export function copyPersonalDocument(
  modal: DocumentModal,
  t: Translate,
  document: DocumentRecord,
  projects: readonly { id: string; name: string }[],
) {
  const operationId = crypto.randomUUID();
  return modal.form(
    t("creative.copy"),
    `<p>${messageHtml("creative.copyHint", {}, t)}</p><p class="resource-copy-source" data-i18n-ignore>${e(document.title)} · v${document.revision}</p><div class="resource-copy-projects">${projects.map((project) => `<label><input type="checkbox" name="project-${e(project.id)}"><span data-i18n-ignore>${e(project.name)}</span></label>`).join("") || `<p>${messageHtml("workbench.noMatchingProjects", {}, t)}</p>`}</div>`,
    t("creative.copyCount"),
    async (fields) => {
      const targets = projects.filter((project) => fields["project-" + project.id] === "on").map(({ id }) => id);
      if (!targets.length) throw new DocumentApiError(400, { messageId: "creative.selectProjects" });
      const result = await documentJson<{ results: { projectId: string; state: string }[] }>(
        "/api/personal/copy",
        "POST",
        {
          operationId,
          documentId: document.id,
          revisionId: document.revisionId,
          projects: targets,
        },
      );
      if (result.results.some((entry) => entry.state !== "copied"))
        throw new DocumentApiError(409, { messageId: "creative.copyFailed" });
      return result;
    },
  );
}
