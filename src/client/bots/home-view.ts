import type { Translate } from "../../shared/i18n/messages.js";
import type { BotWorkspaceCard } from "../../shared/bots/workspace.js";
import { escapeHtml as e } from "../../shared/html.js";
import { botUi } from "./ui.js";
import { botAvatarHtml } from "./avatar.js";

/** A compact management list keeps personality editing behind the explicit edit action. */
export function botHomeList(cards: BotWorkspaceCard[], search: string, t: Translate) {
  const { h, button } = botUi(t),
    selected = cards.filter(({ bot }) =>
      [bot.name, bot.code, bot.persona?.role].join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    );
  return selected.length
    ? `<div class="bot-manager-list">${selected
        .map(({ bot, counts, integrations }) => {
          const base = "/bots/" + bot.id,
            total = Object.values(counts).reduce((a, b) => a + b, 0);
          return `<article class="bot-manager-row"><a class="bot-manager-identity" href="${base}/chat" data-wb="route" data-route="${base}/chat" data-card-action="${bot.id}:chat">${botAvatarHtml(bot)}<div><h2 data-i18n-ignore title="${e(bot.name)}">${e(bot.name)}</h2><p>${bot.persona?.role ? `<span data-i18n-ignore>${e(bot.persona.role)}</span><span aria-hidden="true"> · </span>` : ""}${h("bots.retainedTasks")} <strong>${total}</strong>${bot.active ? "" : ` · ${h("bots.tasksPaused")}`}</p></div></a><div class="bot-manager-activity"><span>${h("bots.summaryRunning")} <strong>${counts.running ?? 0}</strong></span><span>${h("bots.summaryAttention")} <strong>${(counts.error ?? 0) + (counts.suspended ?? 0)}</strong></span></div><div class="bot-record-actions"><a class="wb-button" href="${base}/tasks" data-wb="route" data-route="${base}/tasks">${h("bots.tasks")}</a><a class="wb-button" href="${base}/integrations" data-wb="route" data-route="${base}/integrations">${h("bots.integrations")} <small>${integrations.enabled}</small></a>${button("cli.botEdit", `data-edit="${e(bot.id)}" data-card-action="${e(bot.id)}:edit"`)}${button("cli.botDeleteAssistant", `data-delete-assistant="${e(bot.id)}" data-card-action="${e(bot.id)}:delete"`, false, "trash")}</div></article>`;
        })
        .join("")}</div>`
    : `<div class="bot-empty"><h2>${h(search ? "cli.botNoMatches" : "bots.emptyTitle")}</h2><p>${h(search ? "cli.botNoMatchesHint" : "bots.emptyHint")}</p>${button("cli.botCreate", "data-new-bot")}</div>`;
}
