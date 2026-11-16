import type { CreationAvailability } from "../../shared/creation/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";

export interface CreationLocation {
  id: string | null;
  label: string;
}
export function creationLoadingFrame(t: Translate) {
  return `<header class="creation-heading"><h2>${e(t("creation.title"))}</h2><button type="button" class="wb-button" data-creation-close aria-label="${e(t("creation.close"))}">${codexIcon("x")}</button></header><p role="status">${e(t("creation.loading"))}</p>`;
}
export function creationFrame(
  t: Translate,
  options: CreationAvailability,
  locations: readonly CreationLocation[],
  personal = false,
) {
  return `<header class="creation-heading"><div><h2>${e(t("creation.title"))}</h2><p>${e(t(personal ? "creative.personalCreationHint" : "creation.subtitle"))}</p></div><button type="button" class="wb-button" data-creation-close aria-label="${e(t("creation.close"))}">${codexIcon("x")}</button></header><div class="creation-scroll"><form class="wb-form creation-compose"><label class="wb-field"><span>${e(t("creation.prompt"))}</span><textarea name="prompt" required maxlength="16000" rows="5" placeholder="${e(t("creation.promptHint"))}"></textarea></label><div class="wb-form-grid"><label class="wb-field"><span>${e(t("creation.location"))}</span><select name="parentId">${locations.map((location) => `<option value="${e(location.id ?? "")}">${e(location.label)}</option>`).join("")}</select></label><label class="wb-field"><span>${e(t("creation.model"))}</span><select name="profileId" required>${options.profiles.map((profile) => `<option value="${e(profile.id)}">${e(profile.model || profile.engineId)}</option>`).join("")}</select></label></div><section class="creation-skills"><h3>${e(t("creation.skills"))}</h3><p>${e(t("creation.orderedSkillsHint"))}</p><div data-creation-skills></div></section><p class="creation-reference">${e(t("creation.referenceHint"))}</p><footer class="creation-submit"><button type="button" class="wb-button" data-creation-manual>${e(t("creation.manualWrite"))}</button><button type="submit" class="wb-button primary" data-creation-submit ${options.state === "ready" ? "" : "disabled"}>${e(t("creation.create"))}</button></footer></form><p data-creation-notice role="status" hidden></p><section class="creation-history"><header><h3>${e(t("creation.recent"))}</h3><button type="button" class="wb-button" data-creation-refresh>${codexIcon("refreshCw")}<span>${e(t("creation.refresh"))}</span></button></header><div data-creation-tasks></div></section></div>`;
}
