import type { SkillDefinition } from "../../shared/skills/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";

/** Planning packages supply guidance; the application's connected tools deliver the user's requested artifact. */
export function creationSkillDelivery(t: Translate, skill: SkillDefinition) {
  if (skill.outputTypes.length !== 1 || skill.outputTypes[0] !== "document") return "";
  const messages = {
    image: "creation.imageDocumentOnly",
    slides: "creation.slidesDocumentOnly",
    video: "creation.videoDocumentOnly",
    web: "creation.webDocumentOnly",
  } as const;
  if (!(skill.category in messages)) return "";
  return t(messages[skill.category as keyof typeof messages]);
}

export function creationSkillDeliveryNotice(t: Translate, skill: SkillDefinition) {
  const text = creationSkillDelivery(t, skill);
  return text ? `<div class="creation-skill-delivery">${e(text)}</div>` : "";
}
