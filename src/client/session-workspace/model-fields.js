import { escapeHtml } from "../../shared/html.js";
import { messageHtml } from "../i18n.js";

/** Shared model controls render into dialogs or an inspector without owning session state. */
/** @param {import('../contracts/session-workspace.js').SessionControlView['models']} models
 * @param {{model: string; effort: string; modelId?: string; effortsId?: string}} selection
 * @param {import('../../shared/i18n/messages.js').Translate} t
 */
export function sessionModelFields(models, selection, t) {
  const modelId = selection.modelId || "sessionSettingModel",
    effortsId = selection.effortsId || "sessionSettingEfforts";
  return `<label class="session-form-label" for="${escapeHtml(modelId)}">${messageHtml("common.model", undefined, t)}</label>
    <select class="session-field" id="${escapeHtml(modelId)}" ${models.length ? "" : "disabled"}>
      ${models.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selection.model ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
    </select>
    <fieldset class="session-effort-fieldset"><legend class="sr-only">${messageHtml("common.reasoningEffort", undefined, t)}</legend>
      <div id="${escapeHtml(effortsId)}"></div>
    </fieldset>`;
}
