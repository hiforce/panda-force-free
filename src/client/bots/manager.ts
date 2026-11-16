import type { SettingsModelCatalog } from "../settings-pages/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { botUi, type BotContext, type BotSnapshot } from "./ui.js";
import { botAvatarHtml } from "./avatar.js";
import { openBotEditor } from "./editor.js";
import { keyList, openKeyEditor } from "./keys.js";

export function createBotManager(context: BotContext, models?: SettingsModelCatalog) {
  let tab = "bots";
  return {
    render(host: HTMLElement, snapshot: BotSnapshot) {
      const { h, attributes, optional, button, empty } = botUi(context.t),
        { bots, keys } = snapshot;
      setMessageHtml(
        host,
        `<nav class="bot-tabs" ${attributes("aria-label", "cli.botConfiguration")}>${button("cli.botManage", `data-tab="bots" aria-pressed="${tab === "bots"}"`)}${button("cli.botKeys", `data-tab="keys" aria-pressed="${tab === "keys"}"`)}</nav><div data-manager-content>${tab === "keys" ? keyList(context, keys) : `<div class="bot-list-heading"><div><h2>${h("cli.botManage")}</h2><p>${h("cli.botNoBotsHint")}</p></div>${button("cli.botCreate", "data-new-bot", true, "plus")}</div>${bots.length ? `<div class="bot-config-list">${bots.map((bot) => `<article class="bot-config-row">${botAvatarHtml(bot)}<div class="bot-config-copy"><strong data-i18n-ignore>${e(bot.name)}</strong><small><code data-i18n-ignore>${e(bot.code)}</code> · ${optional(bot.model, "cli.botDefaultModel")}</small><p>${optional(bot.persona?.role || bot.instructions, "cli.botNoInstructions")}</p><small>${optional(bot.callbackHosts.join(", "), "cli.botNoHosts")}</small></div><span class="bot-availability" data-active="${bot.active}">${h(bot.active ? "cli.botActive" : "cli.botPaused")}</span><div class="bot-record-actions">${button("cli.botEdit", `data-edit="${e(bot.id)}"`, false, "pencil")}${button(bot.active ? "cli.botPause" : "cli.botResume", `data-pause="${e(bot.id)}"`)}</div></article>`).join("")}</div>` : empty("cli.botNoBots", "cli.botNoBotsHint")}`}</div><details class="bot-integration"><summary>${h("cli.botManual")}</summary><p>${h("cli.botKeyHint")}</p><pre data-i18n-ignore>POST /api/v1/bots/BOT_CODE/tasks\nAuthorization: Bearer YOUR_API_KEY\nIdempotency-Key: YOUR_EXTERNAL_TASK_ID\nContent-Type: application/json\n\n${e(JSON.stringify({ externalTaskId: "product-001", instructions: context.t("cli.botInstructions"), input: { text: "Product description", images: [] } }, null, 2))}</pre></details>`,
      );
      host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
        (b) =>
          (b.onclick = () => {
            tab = b.dataset.tab!;
            this.render(host, snapshot);
          }),
      );
      host
        .querySelector<HTMLButtonElement>("[data-new-bot]")
        ?.addEventListener("click", () => openBotEditor(host.parentElement!, context, models));
      host.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach(
        (b) =>
          (b.onclick = () =>
            openBotEditor(
              host.parentElement!,
              context,
              models,
              bots.find((bot) => bot.id === b.dataset.edit)!,
            )),
      );
      host.querySelectorAll<HTMLButtonElement>("[data-pause]").forEach(
        (b) =>
          (b.onclick = () =>
            void context.execute(async () => {
              b.disabled = true;
              try {
                const bot = bots.find((bot) => bot.id === b.dataset.pause)!;
                await context.api("/" + bot.id, "PATCH", { active: !bot.active });
                await context.reload();
              } finally {
                b.disabled = false;
              }
            })),
      );
      host
        .querySelector<HTMLButtonElement>("[data-issue-key]")
        ?.addEventListener("click", () =>
          bots.length
            ? openKeyEditor(host.parentElement!, context, bots)
            : context.notice(context.t("cli.botNoBotsHint")),
        );
      host.querySelectorAll<HTMLButtonElement>("[data-revoke]").forEach(
        (b) =>
          (b.onclick = () => {
            if (!window.confirm(context.t("cli.botRevokeConfirm"))) return;
            void context.execute(async () => {
              await context.api("/keys/" + b.dataset.revoke, "DELETE");
              await context.reload();
            });
          }),
      );
    },
  };
}
