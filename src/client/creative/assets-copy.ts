import type { Translate } from "../../shared/i18n/messages.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { readContentAccess } from "../content-access/api.js";
import type { DocumentModal } from "../documents/modal.js";
import { DocumentApiError } from "../documents/api.js";
import { creativeAssetsApi } from "./assets-api.js";

/** Each destination owns a stable idempotent command, including retries after another destination has already succeeded. */
export async function copyCreativeAsset(modal: DocumentModal, t: Translate, asset: CreativeAsset, signal: AbortSignal) {
  const access = await readContentAccess(signal);
  if (signal.aborted) return null;
  const targets = [
      ...access.projects.filter((p) => p.id !== asset.project && p.role === "contributor"),
      ...(asset.project === "personal"
        ? []
        : [{ id: "personal", name: t("creative.personal"), role: "contributor" as const }]),
    ],
    commands = new Map(
      targets.map((p) => [p.id, { id: "c-" + crypto.randomUUID(), operationId: crypto.randomUUID() }]),
    ),
    completed = new Set<string>();
  return modal.form(
    t("creative.copy"),
    `<p>${e(t("creative.copyHint"))}</p><p class="resource-copy-source" data-i18n-ignore>${e(asset.title)}</p><div class="resource-copy-projects">${targets.map((p) => `<label><input type="checkbox" name="project-${e(p.id)}"><span data-i18n-ignore>${e(p.name)}</span></label>`).join("") || `<p>${e(t("workbench.noMatchingProjects"))}</p>`}</div>`,
    t("creative.copyCount"),
    async (fields) => {
      const selected = targets.filter((p) => fields["project-" + p.id] === "on");
      if (!selected.length) throw new DocumentApiError(400, { messageId: "creative.selectProjects" });
      for (const target of selected) {
        if (signal.aborted) throw new Error("Aborted");
        if (completed.has(target.id)) continue;
        const command = commands.get(target.id)!;
        await creativeAssetsApi.copy(asset, target.id, command.id, command.operationId, signal);
        completed.add(target.id);
      }
      return completed.size;
    },
  );
}
