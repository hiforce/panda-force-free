import type { BotConnectionView, BotIntegrationView } from "../../shared/bots/integrations.js";
import { escapeHtml as e } from "../../shared/html.js";
import { botUi, type BotContext } from "./ui.js";
import { botDialog, dialogPending } from "./dialog.js";

export function openBotIntegrationEditor(
  host: HTMLElement,
  context: BotContext,
  botId: string,
  connections: BotConnectionView[],
  current?: BotIntegrationView,
) {
  const { h, field, button, option } = botUi(context.t),
    config = current?.config,
    id = config?.id ?? crypto.randomUUID(),
    choices = (kind: string) =>
      connections
        .filter((c) => c.kind === kind)
        .map(
          (c) =>
            `<option value="${e(c.id)}">${e(c.name)} · ${e(context.t(c.state === "ready" ? "bots.connectionReady" : "bots.connectionUnverified"))}</option>`,
        )
        .join(""),
    dialog = botDialog(
      host,
      context,
      current ? "bots.edit" : "bots.newIntegration",
      "bots.integrationHint",
      `<form class="wb-form" data-integration-editor>
      ${field("bots.integrationName", "name", 'required maxlength="120" autofocus')}
      <div class="wb-form-grid"><label class="wb-field"><span>${h("bots.source")}</span><select name="source">${option("rss", "bots.rss")}${option("gmail", "bots.gmail")}</select></label>
      <label class="wb-field" data-source="rss"><span>${h("bots.feedUrl")}</span><input name="url" type="url" maxlength="4096" placeholder="https://example.com/feed.xml"></label>
      <label class="wb-field" data-source="gmail"><span>${h("bots.mailbox")}</span><select name="mailbox"><option value="">—</option>${choices("gmail")}</select></label></div>
      <label class="wb-field" data-source="gmail"><span>${h("bots.mailQuery")}</span><input name="query" maxlength="500"><small>${h("bots.sourceHint")}</small></label>
      <label class="wb-field"><span>${h("bots.integrationInstructions")}</span><textarea name="instructions" rows="3" maxlength="8000"></textarea></label>
      <div class="wb-form-grid"><label class="wb-field"><span>${h("bots.schedule")}</span><select name="schedule">${option("interval", "bots.interval")}${option("daily", "bots.daily")}</select></label>
      <label class="wb-field" data-schedule="interval"><span>${h("bots.minutes")}</span><input name="minutes" type="number" min="5" max="10080" value="30"></label>
      <label class="wb-field" data-schedule="daily"><span>${h("bots.time")}</span><input name="time" type="time" value="09:00"></label>
      <label class="wb-field" data-schedule="daily"><span>${h("bots.timezone")}</span><input name="timezone" maxlength="120" value="UTC"></label></div>
      <label class="wb-choice"><input name="enabled" type="checkbox" checked><span>${h("bots.enabled")}</span></label>
      <label class="wb-choice"><input name="channel" type="checkbox" checked><span>${h("bots.internalChannel")}</span></label>
      <label class="wb-field"><span>${h("bots.retentionDays")}</span><input name="retention" type="number" min="1" max="365" value="30" required><small>${h("bots.retentionHint")}</small></label>
      <details class="bot-form-section"><summary>${h("bots.advancedIntegration")}</summary>
      <label class="wb-choice"><input name="slack" type="checkbox"><span>${h("bots.slackDelivery")}</span></label><div class="wb-form-grid" data-slack-fields><label class="wb-field"><span>${h("bots.connection")}</span><select name="slackConnection"><option value="">—</option>${choices("slack")}</select></label><label class="wb-field"><span>${h("bots.slackChannel")}</span><input name="slackChannel" maxlength="40" placeholder="C0123456789"></label></div>
      <section data-source="gmail"><label class="wb-field"><span>${h("bots.mailMode")}</span><select name="mailMode">${option("draft", "bots.draftMode")}${option("auto", "bots.autoMode")}</select></label>
      <div data-auto><label class="wb-field"><span>${h("bots.allowedSenders")}</span><textarea name="senders" rows="3"></textarea></label><label class="wb-field"><span>${h("bots.dailyLimit")}</span><input name="dailyLimit" type="number" value="5" min="1" max="50"></label><label class="wb-choice"><input name="consent" type="checkbox"><span>${h("bots.autoConsent")}</span></label></div></section></details>
      <footer class="bot-dialog-actions">${button("common.cancel", "data-cancel")}<button type="submit" class="wb-button primary">${h("cli.botSave")}</button></footer></form>`,
    ),
    form = dialog.querySelector<HTMLFormElement>("form")!,
    control = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    set = (name: string, value: string) => {
      control(name).value = value;
    },
    checked = (name: string, value: boolean) => {
      (control(name) as HTMLInputElement).checked = value;
    },
    value = (name: string) => control(name).value,
    on = (name: string) => (control(name) as HTMLInputElement).checked;
  if (config) {
    for (const [key, v] of Object.entries({
      "pf-bot-name": config.name,
      source: config.source.kind,
      instructions: config.instructions,
      schedule: config.schedule.kind,
      retention: String(config.retentionDays),
      mailMode: config.mail.mode,
      senders: config.mail.allowSenders.join("\n"),
      dailyLimit: String(config.mail.dailyLimit),
    }))
      set(key, v);
    if (config.source.kind === "rss") set("url", config.source.url);
    else {
      set("mailbox", config.source.connectionId);
      set("query", config.source.query);
    }
    if (config.schedule.kind === "interval") set("minutes", String(config.schedule.minutes));
    else {
      set("time", config.schedule.time);
      set("timezone", config.schedule.timezone);
    }
    checked("enabled", config.enabled);
    checked("channel", config.delivery.channel);
    checked("slack", !!config.delivery.slack);
    if (config.delivery.slack) {
      set("slackConnection", config.delivery.slack.connectionId);
      set("slackChannel", config.delivery.slack.channel);
    }
  } else set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  function visibility() {
    for (const node of dialog.querySelectorAll<HTMLElement>("[data-source]"))
      node.hidden = node.dataset.source !== value("source");
    for (const node of dialog.querySelectorAll<HTMLElement>("[data-schedule]"))
      node.hidden = node.dataset.schedule !== value("schedule");
    dialog.querySelector<HTMLElement>("[data-auto]")!.hidden = value("mailMode") !== "auto";
    dialog.querySelector<HTMLElement>("[data-slack-fields]")!.hidden = !on("slack");
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input,select,textarea",
    ))
      control.disabled = !!control.closest("[hidden]");
  }
  form.onchange = visibility;
  visibility();
  dialog.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => dialog.close();
  form.onsubmit = (event) => {
    event.preventDefault();
    if (dialog.dataset.pending === "true") return;
    const payload = {
      id,
      botId,
      revision: current?.revision ?? 0,
      name: value("pf-bot-name"),
      source:
        value("source") === "rss"
          ? { kind: "rss", url: value("url") }
          : { kind: "gmail", connectionId: value("mailbox"), query: value("query") },
      instructions: value("instructions"),
      enabled: on("enabled"),
      retentionDays: Number(value("retention")),
      schedule:
        value("schedule") === "interval"
          ? { kind: "interval", minutes: Number(value("minutes")) }
          : { kind: "daily", time: value("time"), timezone: value("timezone") },
      delivery: {
        channel: on("channel"),
        ...(on("slack") ? { slack: { connectionId: value("slackConnection"), channel: value("slackChannel") } } : {}),
      },
      mail: {
        mode: value("source") === "gmail" ? value("mailMode") : "draft",
        allowSenders: value("senders")
          .split(/[\s,;]+/)
          .filter(Boolean),
        dailyLimit: Number(value("dailyLimit")),
      },
      confirmAutoReply: on("consent"),
    };
    void context.execute(async () => {
      dialogPending(dialog, true);
      try {
        await context.api("/" + botId + "/integrations", "POST", payload);
        await context.reload();
        dialog.close();
        context.notice(context.t("bots.integrationSaved"));
      } finally {
        dialogPending(dialog, false);
      }
    });
  };
}
