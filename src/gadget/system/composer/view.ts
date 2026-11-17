import type { GadgetContext } from "../../../client/gadget/contracts.js";
import { composerSkillButton } from "../../../client/composer-skill-button.js";
import { gt } from "../../../client/gadget/messages.js";
import { codexIcon } from "../../../client/codex-icons.js";
import { escapeHtml as e } from "../../../shared/html.js";

/** The input belongs to the registered gadget, including while optional tools are downloading. */
export function composerFrame(context: GadgetContext, prompt: string) {
  return `<form class="gadget-document-form message-composer message-composer-embedded"><div data-gd-selected class="creative-selected-skills"></div><textarea class="message-composer-input" id="gadgetDocumentPrompt" aria-label="${e(context.t("creation.prompt"))}" placeholder="${e(gt(context.t, "briefPlaceholder"))}" rows="5">${e(prompt)}</textarea><div class="gadget-document-suggestions" data-gd-suggestions hidden>${(["article", "plan", "notes"] as const).map((key) => `<button type="button" data-gd-suggestion="${key}">${e(context.t(`projects.idea${key === "article" ? "Article" : key === "plan" ? "Plan" : "Notes"}`))}${codexIcon("arrowUpRight")}</button>`).join("")}</div><footer class="message-composer-footer">${composerSkillButton(context.t, "data-gd-skills")}<button type="button" class="gadget-document-destination" data-gd-project aria-haspopup="menu" aria-expanded="false">${codexIcon("folderOpen")}<span data-gd-project-title></span>${codexIcon("chevronDown")}</button><div data-gd-project-menu class="gadget-document-destinations" hidden></div><button type="submit" class="gadget-document-send" data-gd-start aria-label="${e(context.t("common.sendMessage"))}">${codexIcon("arrowUp")}</button></footer><div class="gadget-document-status" data-gd-status hidden><p data-gd-notice role="status"></p><button type="button" data-gd-retry hidden>${e(gt(context.t, "retry"))}</button></div></form>`;
}
