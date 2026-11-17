import { escapeHtml } from "../../shared/html.js";
import { messageHtml } from "../i18n.js";

/** Shared model controls render into dialogs or an inspector without owning session state. */
/** @param {import('../contracts/session-workspace.js').SessionControlView['models'][number]['efforts']} choices
 * @param {string} effort
 * @param {string} name
 */
export function sessionEffortOptions(choices, effort, name = "session-effort") {
  return choices
    .map(
      (item) =>
        `<label><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(item.id)}" ${item.id === effort ? "checked" : ""}/><span>${escapeHtml(item.label)}</span></label>`,
    )
    .join("");
}

/** @param {import('../contracts/session-workspace.js').SessionControlView['models']} models
 * @param {{model: string; effort: string; modelId?: string; effortsId?: string; effortName?: string}} selection
 * @param {import('../../shared/i18n/messages.js').Translate} t
 */
export function sessionModelFields(models, selection, t) {
  const modelId = selection.modelId || "sessionSettingModel",
    effortsId = selection.effortsId || "sessionSettingEfforts",
    selected = models.find((item) => item.id === selection.model),
    choices = selected?.efforts || [];
  return `<label class="session-form-label" for="${escapeHtml(modelId)}">${messageHtml("common.model", undefined, t)}</label>
    <select class="session-field" id="${escapeHtml(modelId)}" ${models.length ? "" : "disabled"}>
      ${models.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selection.model ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
    </select>
    <fieldset class="session-effort-fieldset"><legend>${messageHtml("common.reasoningEffort", undefined, t)}</legend>
      <div class="session-effort-segments" id="${escapeHtml(effortsId)}">${sessionEffortOptions(choices, selection.effort, selection.effortName)}</div>
    </fieldset>`;
}
