import type {
  BotConnectionView,
  BotIntegrationView,
  BotIntegrationRunView,
  BotChannelMessage,
  BotSourceItem,
} from "../../shared/bots/integrations.js";
import type { MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { botUi, botDate, type BotContext } from "./ui.js";
import { botDialog, dialogPending } from "./dialog.js";
import { openBotIntegrationEditor } from "./integration-editor.js";
import { openBotConnectionEditor } from "./connection-editor.js";
interface Receipt {
  id: string;
  kind: string;
  state: string;
  failure?: string;
  receipt?: { id: string };
}
const runIds: Record<string, MessageId> = {
  queued: "bots.runQueued",
  collecting: "bots.runCollecting",
  processing: "bots.runProcessing",
  delivering: "bots.runDelivering",
  complete: "bots.runComplete",
  review: "bots.runReview",
  failed: "bots.runFailed",
  canceled: "bots.runCanceled",
};
const deliveryIds: Record<string, MessageId> = {
  queued: "bots.deliveryQueued",
  dispatching: "bots.deliveryDispatching",
  sent: "bots.deliverySent",
  unknown: "bots.deliveryUnknown",
  failed: "bots.deliveryFailed",
  canceled: "bots.deliveryCanceled",
  draft: "bots.replyDraft",
};
const connectionIds: Record<string, MessageId> = {
  ready: "bots.connectionReady",
  unverified: "bots.connectionUnverified",
  error: "bots.connectionError",
  disabled: "bots.connectionDisabled",
};
export function createBotIntegrations(context: BotContext, host: HTMLElement, botId: string) {
  const dialogHost = host.closest<HTMLElement>(".bot-workspace") ?? host;
  let alive = true,
    fingerprint = "",
    connections: BotConnectionView[] = [],
    integrations: BotIntegrationView[] = [],
    selected = "",
    tab = "channel",
    connectionsOpen = false,
    expanded = false,
    next: string | null = null;
  let channelItems: BotChannelMessage[] = [],
    runItems: BotIntegrationRunView[] = [],
    receiptItems: Receipt[] = [];
  const pendingRuns = new Map<string, { requestId: string; revision: number; preview: boolean }>(),
    { h, button } = botUi(context.t),
    base = "/" + botId + "/integrations";
  const selectedBase = () => base + "/" + selected;
  const id = (value: string) => encodeURIComponent(value);
  const failure = (code?: string) =>
    code
      ? h(
          code === "dailyLimit"
            ? "bots.quotaReached"
            : code === "alreadyReplied"
              ? "bots.alreadyReplied"
              : code.includes("source") || ["authentication", "rateLimited"].includes(code)
                ? "bots.sourceError"
                : "bots.draftReview",
        )
      : "";
  function editor(current?: BotIntegrationView) {
    openBotIntegrationEditor(dialogHost, context, botId, connections, current);
  }
  function render() {
    const active =
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset.integrationFocus : undefined;
    setMessageHtml(
      host,
      `<section class="bot-integrations"><div class="bot-record-actions">${button("bots.newIntegration", "data-add-integration", true)}${button("bots.connections", `data-connections aria-expanded="${connectionsOpen}"`)}</div>
      ${connectionsOpen ? `<section class="bot-integration-section"><header><h2>${h("bots.connections")}</h2>${button("bots.newConnection", "data-add-connection")}</header><p>${h("bots.connectionHint")}</p><div class="bot-integration-list">${connections.map((c) => `<article class="bot-integration-row"><div><strong data-i18n-ignore>${e(c.name)}</strong><small>${h(c.kind === "slack" ? "bots.slack" : "bots.gmail")} · ${h(connectionIds[c.state]!)}${c.account ? ` · <span data-i18n-ignore>${e(c.account)}</span>` : ""}</small></div><div class="bot-record-actions">${button("bots.edit", `data-edit-connection="${e(c.id)}"`)}${button(c.state === "disabled" ? "bots.enableConnection" : "bots.disableConnection", `data-toggle-connection="${e(c.id)}"`)}${button("bots.testConnection", `data-test="${e(c.id)}" ${c.state === "disabled" ? "disabled" : ""}`)}</div></article>`).join("") || `<p>${h("bots.noResults")}</p>`}</div></section>` : ""}
      <section class="bot-integration-section"><div class="bot-integration-list">${integrations.map((entry) => `<article class="bot-integration-row" data-selected="${entry.config.id === selected}"><div><button class="wb-button bot-integration-name" data-select-integration="${e(entry.config.id)}" data-integration-focus="${e(entry.config.id)}"><strong data-i18n-ignore>${e(entry.config.name)}</strong></button><small>${h(entry.config.enabled ? "bots.active" : "bots.paused")} · ${h(entry.config.source.kind === "rss" ? "bots.rss" : "bots.gmail")}${entry.nextRunAt ? ` · ${h("bots.nextRun")} <time>${e(botDate(entry.nextRunAt))}</time>` : ""}</small></div><div class="bot-record-actions">${button("bots.edit", `data-edit-integration="${e(entry.config.id)}"`)}${button("bots.previewSource", `data-run="${e(entry.config.id)}" data-preview="true"`)}${button("bots.runNow", `data-run="${e(entry.config.id)}"`)}</div></article>`).join("") || `<p>${h("bots.noIntegrations")}</p>`}</div></section>
      ${
        selected
          ? `<section class="bot-integration-section"><nav class="bot-record-actions" aria-label="${e(context.t("bots.viewResults"))}">${["channel", "runs", "deliveries"].map((key) => button(({ channel: "bots.privateChannel", runs: "bots.runHistory", deliveries: "bots.receipts" } as const)[key as "channel" | "runs" | "deliveries"], `data-tab="${key}" aria-pressed="${key === tab}"`, key === tab)).join("")}</nav><div class="bot-integration-results">${
              tab === "channel"
                ? channelItems
                    .map(
                      (m) =>
                        `<article class="bot-channel-message"><header><h3 data-i18n-ignore>${e(m.title ?? "")}</h3><time>${e(botDate(m.createdAt))}</time></header><div class="bot-channel-text" data-i18n-ignore>${e(m.text)}</div>${m.sources
                          .filter((s) => !!s.url)
                          .map(
                            (s) =>
                              `<a href="${e(s.url)}" target="_blank" rel="noreferrer" data-i18n-ignore>${e(s.title)}</a>`,
                          )
                          .join(
                            "",
                          )}${m.reply ? `<section class="bot-mail-draft"><h4>${h("bots.replyDraft")}</h4><p>${h("bots.recipient")}: <span data-i18n-ignore>${e(m.reply.to)}</span></p><div class="bot-channel-text" data-i18n-ignore>${e(m.reply.text)}</div><p>${h(deliveryIds[m.reply.state] ?? "bots.draftReview")}</p>${m.draftFailure ? `<p>${failure(m.draftFailure)}</p>` : ""}${["draft", "failed"].includes(m.reply.state) ? button("bots.sendReply", `data-send-reply="${e(m.id)}"`) : ""}</section>` : ""}</article>`,
                    )
                    .join("")
                : tab === "runs"
                  ? runItems
                      .map(
                        (r) =>
                          `<article class="bot-integration-row"><div><strong>${h(runIds[r.state] ?? "bots.runReview")}${r.preview ? ` · ${h("bots.previewSource")}` : ""}</strong><small>${e(botDate(r.createdAt))} · ${e(context.t("bots.collected", { count: String(r.itemCount) }))}</small>${r.failure ? `<p>${failure(r.failure)}</p>` : ""}</div><div class="bot-record-actions">${r.preview && r.state === "complete" ? button("bots.previewItems", `data-preview-run="${e(r.id)}"`) : ""}${r.taskIds.length ? `<a class="wb-button" data-wb="route" data-route="/bots/${botId}/tasks" href="/bots/${botId}/tasks">${h("bots.tasks")}</a>` : ""}${!["complete", "failed", "canceled"].includes(r.state) ? button("bots.cancelRun", `data-cancel-run="${e(r.id)}"`) : ""}</div></article>`,
                      )
                      .join("")
                  : receiptItems
                      .map(
                        (r) =>
                          `<article class="bot-integration-row"><div><strong>${h(r.kind === "slack" ? "bots.slack" : "bots.gmail")}</strong><small>${h(deliveryIds[r.state] ?? "bots.deliveryUnknown")}</small>${r.failure ? `<p>${failure(r.failure)}</p>` : ""}${r.receipt ? `<small data-i18n-ignore>${e(r.receipt.id)}</small>` : ""}</div><div class="bot-record-actions">${r.state === "unknown" && r.kind === "gmail" ? button("bots.checkSent", `data-reconcile="${e(r.id)}"`) : ""}${r.state === "failed" ? button("bots.retryDelivery", `data-retry="${e(r.id)}"`) : ""}</div></article>`,
                      )
                      .join("") || `<p>${h("bots.noResults")}</p>`
            }</div>${next ? button("bots.more", "data-more") : ""}</section>`
          : ""
      }</section>`,
    );
    if (active)
      host
        .querySelector<HTMLElement>(`[data-integration-focus="${CSS.escape(active)}"]`)
        ?.focus({ preventScroll: true });
    host.querySelector<HTMLButtonElement>("[data-add-integration]")!.onclick = () => editor();
    host.querySelector<HTMLButtonElement>("[data-connections]")!.onclick = () => {
      connectionsOpen = !connectionsOpen;
      render();
    };
    host
      .querySelector<HTMLButtonElement>("[data-add-connection]")
      ?.addEventListener("click", () => openBotConnectionEditor(dialogHost, context));
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-select-integration]"))
      b.onclick = () => {
        selected = b.dataset.selectIntegration!;
        reset();
        void context.execute(reload);
      };
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-tab]"))
      b.onclick = () => {
        tab = b.dataset.tab!;
        reset();
        void context.execute(reload);
      };
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-edit-integration]"))
      b.onclick = () => editor(integrations.find((v) => v.config.id === b.dataset.editIntegration));
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-edit-connection]"))
      b.onclick = () =>
        openBotConnectionEditor(
          dialogHost,
          context,
          connections.find((v) => v.id === b.dataset.editConnection),
        );
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-toggle-connection]"))
      b.onclick = () => {
        const c = connections.find((v) => v.id === b.dataset.toggleConnection)!;
        action(b, () =>
          context.api("/connections", "POST", {
            id: c.id,
            revision: c.revision,
            name: c.name,
            kind: c.kind,
            enabled: c.state === "disabled",
          }),
        );
      };
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-test]"))
      b.onclick = () =>
        action(b, async () => {
          await context.api("/connections/" + b.dataset.test + "/test", "POST", {});
          context.notice(context.t("bots.connectionTested"));
        });
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-run]"))
      b.onclick = () => {
        const integrationId = b.dataset.run!,
          preview = b.dataset.preview === "true";
        if (preview) action(b, () => run(integrationId, true));
        else {
          const dialog = botDialog(
            dialogHost,
            context,
            "bots.runNow",
            "bots.runConfirm",
            button("bots.runNow", "data-confirm-run", true),
          );
          dialog.querySelector<HTMLButtonElement>("[data-confirm-run]")!.onclick = () =>
            void context.execute(async () => {
              dialogPending(dialog, true);
              try {
                await run(integrationId, false);
                dialog.close();
              } finally {
                dialogPending(dialog, false);
              }
            });
        }
      };
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-cancel-run]"))
      b.onclick = () =>
        action(b, () => context.api(selectedBase() + "/runs/" + id(b.dataset.cancelRun!) + "/cancel", "POST", {}));
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-preview-run]"))
      b.onclick = () =>
        action(b, async () => {
          const value = await context.api<{ items: BotSourceItem[]; limited: boolean }>(
            selectedBase() + "/runs/" + id(b.dataset.previewRun!),
          );
          botDialog(
            dialogHost,
            context,
            "bots.previewItems",
            "bots.previewHint",
            `${value.limited ? `<p>${h("bots.previewLimited")}</p>` : ""}${value.items.map((item) => `<article class="bot-channel-message"><h3 data-i18n-ignore>${e(item.title)}</h3><p class="bot-channel-text" data-i18n-ignore>${e(item.text)}</p><a href="${e(item.url)}" target="_blank" rel="noreferrer" data-i18n-ignore>${e(item.url)}</a></article>`).join("") || h("bots.noResults")}`,
          );
        });
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-send-reply]"))
      b.onclick = () => reply(channelItems.find((m) => m.id === b.dataset.sendReply)!);
    for (const key of ["retry", "reconcile"] as const)
      for (const b of host.querySelectorAll<HTMLButtonElement>("[data-" + key + "]"))
        b.onclick = () =>
          action(b, () => context.api(selectedBase() + "/deliveries/" + id(b.dataset[key]!) + "/" + key, "POST", {}));
    host
      .querySelector<HTMLButtonElement>("[data-more]")
      ?.addEventListener("click", () => void context.execute(() => loadResults(next!)));
  }
  function reset() {
    channelItems = [];
    runItems = [];
    receiptItems = [];
    next = null;
    expanded = false;
    fingerprint = "";
  }
  function action(b: HTMLButtonElement, work: () => Promise<unknown>) {
    if (b.disabled) return;
    b.disabled = true;
    void context.execute(async () => {
      try {
        await work();
        await reload();
      } finally {
        b.disabled = false;
      }
    });
  }
  async function run(integrationId: string, preview: boolean) {
    const key = integrationId + ":" + preview;
    let payload = pendingRuns.get(key);
    if (!payload) {
      const snapshot = await context.api<{ integrations: BotIntegrationView[] }>(base),
        entry = snapshot.integrations.find((v) => v.config.id === integrationId)!;
      payload = { requestId: crypto.randomUUID(), revision: entry.revision, preview };
      pendingRuns.set(key, payload);
    }
    try {
      await context.api(base + "/" + integrationId + "/runs", "POST", payload);
    } catch (error) {
      if (
        error instanceof Error &&
        ["staleIntegration", "invalidRun", "integrationBusy", "notFound", "forbidden"].includes(error.message)
      )
        pendingRuns.delete(key);
      throw error;
    }
    pendingRuns.delete(key);
    selected = integrationId;
    tab = "runs";
    reset();
    await reload();
  }
  function reply(message: BotChannelMessage) {
    const requestId = crypto.randomUUID(),
      dialog = botDialog(
        dialogHost,
        context,
        "bots.sendReply",
        "bots.replyConfirm",
        `<form class="wb-form"><p>${h("bots.recipient")}: <strong data-i18n-ignore>${e(message.reply!.to)}</strong></p><label class="wb-field"><span>${h("bots.replyDraft")}</span><textarea name="reply" required maxlength="10000" rows="8"></textarea></label><button class="wb-button primary" type="submit">${h("bots.sendReply")}</button></form>`,
      ),
      form = dialog.querySelector<HTMLFormElement>("form")!,
      input = form.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = message.reply!.text;
    let uncertain: string | undefined;
    form.onsubmit = (event) => {
      event.preventDefault();
      if (dialog.dataset.pending === "true") return;
      uncertain ??= input.value;
      void context.execute(async () => {
        dialogPending(dialog, true);
        try {
          await context.api(selectedBase() + "/channel/" + id(message.id) + "/send", "POST", {
            requestId,
            text: uncertain,
            confirm: true,
          });
          dialog.close();
          await reload();
        } catch (error) {
          if (
            error instanceof Error &&
            ["invalidDelivery", "notFound", "connectionUnavailable", "conflict", "deliveryCannotRetry"].includes(
              error.message,
            )
          )
            uncertain = undefined;
          throw error;
        } finally {
          dialogPending(dialog, false);
          input.readOnly = !!uncertain;
        }
      });
    };
  }
  async function loadResults(before?: string) {
    if (!selected) return;
    const current = selected + ":" + tab,
      value = await context.api<{
        messages?: BotChannelMessage[];
        runs?: BotIntegrationRunView[];
        deliveries?: Receipt[];
        next: string | null;
      }>(selectedBase() + "/" + tab + (before ? "?before=" + encodeURIComponent(before) : ""));
    if (!alive || current !== selected + ":" + tab) return;
    const merge = <T extends { id: string }>(old: T[], incoming: T[]) => [
      ...new Map([...old, ...incoming].map((v) => [v.id, v])).values(),
    ];
    const refresh = <T extends { id: string }>(old: T[], incoming: T[]) => [
      ...incoming,
      ...old.filter((v) => !incoming.some((fresh) => fresh.id === v.id)),
    ];
    if (before) expanded = true;
    if (value.messages)
      channelItems = (
        before ? merge(channelItems, value.messages) : expanded ? refresh(channelItems, value.messages) : value.messages
      ).filter((v) => v.expiresAt > Date.now());
    if (value.runs)
      runItems = before ? merge(runItems, value.runs) : expanded ? refresh(runItems, value.runs) : value.runs;
    if (value.deliveries)
      receiptItems = before
        ? merge(receiptItems, value.deliveries)
        : expanded
          ? refresh(receiptItems, value.deliveries)
          : value.deliveries;
    if (before || !expanded) next = value.next;
    const state = JSON.stringify([
      connectionsOpen,
      connections,
      integrations,
      selected,
      tab,
      channelItems,
      runItems,
      receiptItems,
      next,
    ]);
    if (state !== fingerprint) {
      fingerprint = state;
      render();
    }
  }
  async function reload() {
    const value = await context.api<{ integrations: BotIntegrationView[]; connections: BotConnectionView[] }>(base);
    if (!alive) return;
    integrations = value.integrations;
    connections = value.connections;
    selected ||= integrations[0]?.config.id ?? "";
    if (selected) await loadResults();
    else render();
  }
  return {
    reload,
    hide() {
      alive = false;
    },
  };
}
