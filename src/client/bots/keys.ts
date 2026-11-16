import type { BotConfig } from "../../shared/bots/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { copyPlainText } from "../clipboard-text.js";
import { botDialog, dialogPending } from "./dialog.js";
import { botUi, type BotContext, type BotKey } from "./ui.js";

export function keyList(context: BotContext, keys: BotKey[]) {
  const { h, button, icon, empty } = botUi(context.t);
  return `<div class="bot-list-heading"><div><h2>${h("cli.botKeys")}</h2><p>${h("cli.botKeyHint")}</p></div>${button("cli.botKeyCreate", "data-issue-key", true, "plus")}</div>${keys.length ? `<div class="bot-config-list">${keys.map((key) => `<article class="bot-config-row">${icon("shield")}<div class="bot-config-copy"><strong data-i18n-ignore>${e(key.name)}</strong><small>${h("cli.botExpires")} · ${e(new Date(key.expiresAt).toLocaleDateString(document.documentElement.lang))}</small></div>${key.revokedAt ? `<span class="bot-neutral">${h("cli.botRevoked")}</span>` : button("cli.revoke", `data-revoke="${e(key.id)}"`)}</article>`).join("")}</div>` : empty("cli.botKeyEmpty", "cli.botKeyEmptyHint")}`;
}
export function openKeyEditor(host: HTMLElement, context: BotContext, bots: BotConfig[]) {
  const { h, field, button } = botUi(context.t),
    dialog = botDialog(
      host,
      context,
      "cli.botKeyCreate",
      "cli.botKeyHint",
      `<form data-issue-key-form class="wb-form">${field("cli.botName", "name", 'required maxlength="120" autofocus')}<fieldset class="bot-key-scope"><legend>${h("cli.botKeyBots")}</legend>${bots.map((bot) => `<label class="wb-choice"><input type="checkbox" name="pf-bot-bot" value="${e(bot.id)}"><span data-i18n-ignore>${e(bot.name)}</span></label>`).join("")}</fieldset>${field("cli.expiry", "days", 'type="number" min="1" max="365" value="90" required')}<footer class="bot-dialog-actions">${button("common.cancel", "data-key-cancel")}<button class="wb-button primary" type="submit">${h("cli.botKeyCreate")}</button></footer></form>`,
    );
  dialog.querySelector<HTMLButtonElement>("[data-key-cancel]")!.onclick = () => dialog.close();
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (dialog.dataset.pending === "true") return;
    const data = new FormData(form);
    if (!data.getAll("pf-bot-bot").length) return context.notice(context.t("cli.botKeyRequired"));
    void context.execute(async () => {
      dialogPending(dialog, true);
      try {
        const result = await context.api<{ secret: string }>("/keys", "POST", {
          name: data.get("pf-bot-name"),
          days: Number(data.get("pf-bot-days")),
          botIds: data.getAll("pf-bot-bot"),
        });
        await context.reload();
        if (!dialog.isConnected) return;
        setMessageHtml(
          dialog.querySelector(".bot-dialog-body")!,
          `<div class="wb-form bot-key-result"><h3>${h("cli.botKeyCreated")}</h3><p>${h("cli.botKeyOnce")}</p><label class="wb-field"><span>API Key</span><input readonly data-key aria-label="API Key" spellcheck="false"></label><footer class="bot-dialog-actions">${button("cli.botCopy", "data-copy", true, "copy")}${button("common.close", "data-key-done")}</footer></div>`,
        );
        const field = dialog.querySelector<HTMLInputElement>("[data-key]")!;
        field.value = result.secret;
        dialog.querySelector<HTMLButtonElement>("[data-copy]")!.onclick = () =>
          void copyPlainText(field.value)
            .then(() => context.notice(context.t("cli.botCopied")))
            .catch(() => {
              field.focus();
              field.select();
              context.notice(context.t("cli.botCopyFailed"));
            });
        dialog.querySelector<HTMLButtonElement>("[data-key-done]")!.onclick = () => dialog.close();
        context.notice("");
      } finally {
        dialogPending(dialog, false);
      }
    });
  };
}
