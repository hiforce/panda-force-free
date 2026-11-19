import type { BotConnectionView } from "../../shared/bots/integrations.js";
import { botUi, type BotContext } from "./ui.js";
import { botDialog, dialogPending } from "./dialog.js";
export function openBotConnectionEditor(host: HTMLElement, context: BotContext, current?: BotConnectionView) {
  const { h, field, option } = botUi(context.t),
    id = current?.id ?? crypto.randomUUID(),
    dialog = botDialog(
      host,
      context,
      current ? "bots.edit" : "bots.newConnection",
      "bots.connectionHint",
      `<form class="wb-form" data-connection-editor>${field("bots.connectionName", "name", 'required maxlength="120" autofocus')}<label class="wb-field"><span>${h("bots.provider")}</span><select name="kind" ${current ? "disabled" : ""}>${option("slack", "bots.slack")}${option("gmail", "bots.gmail")}</select></label><div data-kind="slack">${field("bots.slackToken", "token", 'type="password" autocomplete="new-password" maxlength="8192"')}</div><div data-kind="gmail">${field("bots.clientId", "clientId", 'autocomplete="off" maxlength="8192"')}${field("bots.clientSecret", "clientSecret", 'type="password" autocomplete="new-password" maxlength="8192"')}${field("bots.refreshToken", "refreshToken", 'type="password" autocomplete="new-password" maxlength="8192"')}</div><p>${h("bots.credentialHint")}</p><p>${h("bots.providerHelp")}</p><footer class="bot-dialog-actions"><button type="submit" class="wb-button primary">${h("cli.botSave")}</button></footer></form>`,
    ),
    form = dialog.querySelector<HTMLFormElement>("form")!,
    select = form.elements.namedItem("kind") as HTMLSelectElement;
  select.value = current?.kind ?? "slack";
  (form.elements.namedItem("pf-bot-name") as HTMLInputElement).value = current?.name ?? "";
  const visibility = () => {
    for (const node of dialog.querySelectorAll<HTMLElement>("[data-kind]"))
      node.hidden = node.dataset.kind !== select.value;
  };
  select.onchange = visibility;
  visibility();
  form.onsubmit = (event) => {
    event.preventDefault();
    if (dialog.dataset.pending === "true") return;
    const data = new FormData(form),
      keys = select.value === "slack" ? ["token"] : ["clientId", "clientSecret", "refreshToken"],
      credential = Object.fromEntries(keys.map((k) => [k, String(data.get("pf-bot-" + k) ?? "")]));
    void context.execute(async () => {
      dialogPending(dialog, true);
      try {
        await context.api("/connections", "POST", {
          id,
          revision: current?.revision ?? 0,
          name: data.get("pf-bot-name"),
          kind: select.value,
          ...(Object.values(credential).some(Boolean) || !current ? { credential } : {}),
        });
        await context.reload();
        dialog.close();
        context.notice(context.t("bots.connectionSaved"));
      } finally {
        dialogPending(dialog, false);
      }
    });
  };
}
