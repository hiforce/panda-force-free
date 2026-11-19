import { codexIcon } from "./codex-icons.js";
import { escapeHtml as e } from "../shared/html.js";
import type { Translate } from "../shared/i18n/messages.js";

/** Creation and conversation composers share the original picker trigger. */
export function composerSkillButton(t: Translate, attribute: "data-gd-skills" | "data-session-skills") {
  return `<button type="button" class="gadget-document-skill" ${attribute} data-composer-skill-trigger aria-haspopup="dialog">${codexIcon("sparkles")}<span data-gd-skill-label data-pf-message="creation.addSkill">${e(t("creation.addSkill"))}</span>${codexIcon("chevronRight")}</button>`;
}
