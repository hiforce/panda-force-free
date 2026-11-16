import { botUi, type BotContext } from "./ui.js";
import { botDialog, dialogPending } from "./dialog.js";

export async function openBotRetention(host: HTMLElement, context: BotContext) {
  const { days } = await context.api<{ days: number }>("/retention");
  if (!host.isConnected) return;
  const { h, button } = botUi(context.t),
    dialog = botDialog(
      host,
      context,
      "cli.botRetentionTitle",
      null,
      `<form class="wb-form"><p>${h("cli.botRetentionHint")}</p><label class="wb-field"><span>${h("cli.botRetentionDays")}</span><input name="retention" type="number" min="1" max="365" value="${days}" required></label><footer class="bot-dialog-actions">${button("common.cancel", "data-cancel-retention")}<button type="submit" class="wb-button primary">${h("common.save")}</button></footer></form>`,
    );
  dialog.querySelector<HTMLButtonElement>("[data-cancel-retention]")!.onclick = () => dialog.close();
  dialog.querySelector<HTMLFormElement>("form")!.onsubmit = (event) => {
    event.preventDefault();
    if (dialog.dataset.pending === "true") return;
    const days = Number(dialog.querySelector<HTMLInputElement>("input")!.value);
    dialogPending(dialog, true);
    void context
      .api("/retention", "POST", { days })
      .then(() => dialog.close())
      .catch(() => context.notice(context.t("cli.botError")))
      .finally(() => dialogPending(dialog, false));
  };
}
