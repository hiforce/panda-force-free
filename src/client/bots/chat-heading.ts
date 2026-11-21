import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml } from "../../shared/html.js";
import { createAnchoredMenu } from "../anchored-menu.js";
import { botUi } from "./ui.js";

/** Conversation chrome stays on one row; secondary actions share the existing anchored menu lifecycle. */
export function botChatHeading(t: Translate, botId: string) {
  const { h, icon, iconButton, attributes, button } = botUi(t);
  return `<header class="bot-home-heading bot-chat-heading"><a class="wb-button bot-icon-button bot-chat-back" href="/bots" data-wb="route" data-route="/bots" ${attributes("title", "bots.homeTitle")} ${attributes("aria-label", "bots.homeTitle")}>${icon("arrowLeft")}</a><div class="bot-title-row"><span data-bot-profile></span><h1 data-bot-title>${h("bots.chat")}</h1></div><div class="bot-chat-heading-actions">${iconButton("cli.botRefresh", "refreshCw", "data-refresh")}${iconButton("bots.chatOptions", "ellipsis", 'data-chat-options aria-haspopup="menu" aria-expanded="false" aria-controls="bot-chat-options"')}</div><div class="bot-chat-menu" id="bot-chat-options" ${attributes("aria-label", "bots.chatOptions")} hidden>${button("bots.tasks", `data-wb="route" data-route="/bots/${escapeHtml(botId)}/tasks"`, false, "list")}${button("bots.integrations", `data-wb="route" data-route="/bots/${escapeHtml(botId)}/integrations"`, false, "plug")}<div class="bot-chat-menu-actions" data-chat-menu-actions></div><p class="bot-chat-menu-hint">${h("bots.chatHint")}</p></div></header>`;
}

export function bindBotChatHeading(host: HTMLElement) {
  const trigger = host.querySelector<HTMLButtonElement>("[data-chat-options]")!,
    menu = host.querySelector<HTMLElement>(".bot-chat-menu")!,
    controller = createAnchoredMenu();
  trigger.onclick = () => controller.toggle(trigger, menu);
  // Close before an action opens a dialog or navigates, preserving that action's focus.
  const choose = (event: Event) => {
    if (event.target instanceof Element && event.target.closest("button:not(:disabled)")) controller.close(true);
  };
  menu.addEventListener("click", choose, true);
  return {
    actions: host.querySelector<HTMLElement>("[data-chat-menu-actions]")!,
    dispose() {
      controller.dispose();
      menu.removeEventListener("click", choose, true);
      trigger.onclick = null;
    },
  };
}
