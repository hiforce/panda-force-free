import type { BotConfig } from "../../shared/bots/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { botDialog, dialogPending } from "./dialog.js";
import { botUi, type BotContext } from "./ui.js";

export function deleteAssistant(
  host: HTMLElement,
  context: BotContext,
  bot: Pick<BotConfig, "id" | "name">,
  editor?: HTMLDialogElement,
) {
  const { h, button } = botUi(context.t),
    dialog = botDialog(
      host,
      context,
      "cli.botDeleteAssistant",
      null,
      `<p data-i18n-ignore><strong>${e(bot.name)}</strong></p><p>${h("cli.botDeleteAssistantHint")}</p><footer class="bot-dialog-actions">${button("common.cancel", "data-delete-assistant-cancel")}${button("cli.botDeleteAssistant", "data-delete-assistant-confirm", true, "trash")}</footer>`,
    );
  const titleId = "bot-delete-title-" + crypto.randomUUID();
  dialog.querySelector("h2")!.id = titleId;
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.querySelector<HTMLButtonElement>("[data-delete-assistant-cancel]")!.onclick = () => dialog.close();
  dialog.querySelector<HTMLButtonElement>("[data-delete-assistant-confirm]")!.onclick = () => {
    if (dialog.dataset.pending === "true") return;
    void context.execute(async () => {
      dialogPending(dialog, true);
      try {
        try {
          await context.api("/" + bot.id, "DELETE");
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "notFound") throw error;
        }
        dialog.close();
        editor?.close();
        window.dispatchEvent(new Event("panda-bots-changed"));
        if (window.location.pathname.includes(bot.id)) {
          const home = host.querySelector<HTMLAnchorElement>('[data-route="/bots"]');
          if (home) home.click();
          else window.location.assign("/bots");
        } else {
          await context.reload();
          context.notice(context.t("cli.botAssistantDeleted"));
        }
      } finally {
        if (dialog.isConnected) dialogPending(dialog, false);
      }
    });
  };
}
