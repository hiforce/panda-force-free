import type { BotConfig } from "../../shared/bots/contracts.js";
import type { SettingsModelCatalog } from "../settings-pages/contracts.js";
import { botDialog, dialogPending } from "./dialog.js";
import { botUi, type BotContext } from "./ui.js";
import { createBotProfileEditor } from "./profile-editor.js";
import { createBotModelField } from "./model-field.js";

export function openBotEditor(host: HTMLElement, context: BotContext, models?: SettingsModelCatalog, bot?: BotConfig) {
  const { h, field, button } = botUi(context.t),
    model = createBotModelField(context.t, models),
    profile = createBotProfileEditor(context, bot),
    dialog = botDialog(
      host,
      context,
      bot ? "cli.botEdit" : "cli.botCreate",
      bot ? "cli.botEditHint" : "cli.botCreateHint",
      `<form data-create-bot class="wb-form"><section class="bot-form-section"><h3>${h("cli.botGeneralSection")}</h3><div class="wb-form-grid">${field("cli.botName", "name", 'required maxlength="120" autofocus')}${field("cli.botCode", "code", `required pattern="[a-z][a-z0-9_-]{1,63}" maxlength="64" ${bot ? "readonly" : ""}`, bot ? "cli.botReadOnlyCode" : "cli.botCodeHint")}</div></section>${profile.html()}${profile.personality()}<section class="bot-form-section"><h3>${h("cli.botBehaviorSection")}</h3>${model.html()}<label class="wb-field"><span>${h("cli.botInstructions")}</span><textarea name="pf-bot-instructions" maxlength="16000" rows="4"></textarea><small>${h("cli.botInstructionsHint")}</small></label></section><details class="bot-form-section" ${bot?.callbackHosts.length ? "open" : ""}><summary>${h("cli.botCallbackSection")}</summary><label class="wb-field"><span>${h("cli.botHosts")}</span><textarea name="pf-bot-hosts" rows="3" placeholder="api.example.com" spellcheck="false"></textarea><small>${h("cli.botHostsHint")}</small></label></details><footer class="bot-dialog-actions">${button("common.cancel", "data-cancel-edit")}<button type="submit" class="wb-button primary">${h(bot ? "cli.botSave" : "cli.botCreate")}</button></footer></form>`,
    );
  dialog.classList.add("bot-editor-dialog");
  model.mount(dialog, bot?.model);
  dialog.addEventListener("close", model.close);
  dialog.querySelector<HTMLButtonElement>("[data-cancel-edit]")!.onclick = () => dialog.close();
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  for (const [name, value] of Object.entries({
    name: bot?.name ?? "",
    code: bot?.code ?? "",
    instructions: bot?.instructions ?? "",
    hosts: bot?.callbackHosts.join("\n") ?? "",
  }))
    (form.elements.namedItem("pf-bot-" + name) as HTMLInputElement).value = value;
  profile.mount(dialog);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (dialog.dataset.pending === "true") return;
    const data = new FormData(form);
    void context.execute(async () => {
      dialogPending(dialog, true);
      context.notice(context.t("cli.botSaving"));
      try {
        await context.api(bot ? "/" + bot.id : "", bot ? "PATCH" : "POST", {
          name: data.get("pf-bot-name"),
          avatar: profile.value(),
          persona: {
            role: data.get("pf-bot-role"),
            traits: data.get("pf-bot-traits"),
            voice: data.get("pf-bot-voice"),
            motto: data.get("pf-bot-motto"),
          },
          ...(!bot ? { code: data.get("pf-bot-code") } : {}),
          model: data.get("pf-bot-model"),
          instructions: data.get("pf-bot-instructions"),
          callbackHosts: String(data.get("pf-bot-hosts")).split(/\s+/).filter(Boolean),
        });
        await context.reload();
        dialog.close();
        context.notice(context.t(bot ? "cli.botSaved" : "cli.botCreated"));
      } finally {
        dialogPending(dialog, false);
      }
    });
  };
}
