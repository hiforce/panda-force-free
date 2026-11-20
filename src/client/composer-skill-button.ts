import { codexIcon } from "./codex-icons.js";
import { escapeHtml as e } from "../shared/html.js";
import type { MessageId, Translate } from "../shared/i18n/messages.js";

/** Creation and conversation composers share the original picker trigger. */
export function composerSkillButton(
  t: Translate,
  attribute: "data-gd-skills" | "data-session-skills",
  caption?: MessageId,
) {
  const label = `data-gd-skill-label data-pf-message="creation.addSkill"`;
  const copy = caption
    ? `<span><strong ${label}>${e(t("creation.addSkill"))}</strong><small data-pf-message="${caption}">${e(t(caption))}</small></span>`
    : `<span ${label}>${e(t("creation.addSkill"))}</span>`;
  return `<button type="button" class="gadget-document-skill" ${attribute} data-composer-skill-trigger aria-haspopup="dialog">${codexIcon("sparkles")}${copy}${codexIcon("chevronRight")}</button>`;
}
