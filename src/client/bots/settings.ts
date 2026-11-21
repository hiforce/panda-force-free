import { botDialog } from "./dialog.js";
import { openBotRetention } from "./retention.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { BotQueueSnapshot } from "../../shared/bots/contracts.js";
import { request } from "../http-client.js";
import { setMessageHtml } from "../i18n.js";
import { botUi, type BotContext, type BotSnapshot } from "./ui.js";
import { createBotManager } from "./manager.js";
import { createBotTaskList } from "./tasks.js";

/** Each surface owns its lifecycle; configuration remains separate from daily operations. */
function createBotPanel(t: Translate, workspace: boolean) {
  let container: HTMLElement | null = null,
    host: HTMLElement | null = null,
    controller = new AbortController(),
    epoch = 0,
    loadVersion = 0,
    timer: ReturnType<typeof setInterval> | null = null,
    busy = false,
    ready = false,
    pending: Promise<void> | null = null;
  const { h, button, attributes, icon } = botUi(t);
  const context: BotContext = {
    t,
    async api<T>(path = "", method = "GET", body?: unknown): Promise<T> {
      const signal = controller.signal,
        response = await request("/api/bots" + path, {
          method,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        }),
        value = await response.json();
      signal.throwIfAborted();
      if (!response.ok) throw new Error(value.error?.code ?? "unavailable");
      if (method !== "GET") {
        loadVersion++;
        pending = null;
      }
      return value;
    },
    notice(message) {
      const target =
        host
          ?.querySelector<HTMLDialogElement>(".bot-dialog[open]")
          ?.querySelector<HTMLElement>("[data-bot-dialog-notice]") ??
        host?.querySelector<HTMLElement>("[data-bot-notice]");
      if (target) {
        target.textContent = message;
        target.hidden = !message;
      }
    },
    async execute(work) {
      if (busy || !host) return;
      const current = epoch;
      busy = true;
      try {
        await work();
      } catch (error) {
        if (current !== epoch || controller.signal.aborted) return;
        const messages = {
            botBusy: "cli.botAssistantBusy",
            invalidAvatar: "cli.botAvatarInvalid",
            avatarBusy: "cli.botAvatarBusy",
            callbackRequired: "cli.botCallbackRequired",
            callbackHostDenied: "cli.botCallbackHostDenied",
            staleReview: "cli.botReviewStale",
            invalidReview: "cli.botReviewInvalid",
            invalidAction: "cli.botReviewInvalid",
            invalidActions: "cli.botReviewInvalid",
            reviewAnswerRequired: "cli.botReviewAnswerRequired",
            taskRunning: "cli.botDeleteRunning",
            callbackInFlight: "cli.botErrorCallbackInFlight",
            taskDeleted: "cli.botTaskDeleted",
            notFound: "cli.botNotFound",
            bulkRetryLimit: "cli.botRetryLimit",
            bulkDeleteLimit: "cli.botDeleteLimit",
          } as const,
          code = error instanceof Error ? error.message : "";
        context.notice(t(messages[code as keyof typeof messages] ?? "cli.botError"));
      } finally {
        if (current === epoch) busy = false;
      }
    },
    reload(replace = false) {
      if (replace) pending = null;
      if (pending) return pending;
      const current = epoch,
        version = ++loadVersion;
      const work = (async () => {
        const value = workspace
          ? await context.api<BotQueueSnapshot>("/queue?" + tasks.queryString())
          : await context.api<BotSnapshot>("/catalog");
        if (current !== epoch || version !== loadVersion || !host) return;
        const content = host.querySelector<HTMLElement>("[data-bot-content]")!;
        if (workspace) tasks.render(content, value as BotQueueSnapshot);
        else manager.render(content, value as BotSnapshot);
        ready = true;
        host.removeAttribute("aria-busy");
      })().catch((error) => {
        if (current !== epoch || version !== loadVersion || !host) return;
        if (current === epoch && version === loadVersion && host) {
          host.removeAttribute("aria-busy");
          if (!ready) {
            const content = host.querySelector<HTMLElement>("[data-bot-content]")!;
            setMessageHtml(
              content,
              `<div class="bot-empty"><p>${h("cli.botLoadFailed")}</p>${button("common.retry", "data-load-retry")}</div>`,
            );
            content.querySelector<HTMLButtonElement>("[data-load-retry]")!.onclick = () =>
              void context.execute(context.reload);
          }
        }
        throw error;
      });
      pending = work;
      void work
        .finally(() => {
          if (pending === work) pending = null;
        })
        .catch(() => {});
      return work;
    },
  };
  const tasks = createBotTaskList(context),
    manager = createBotManager(context);
  function hide() {
    epoch++;
    controller.abort();
    if (timer) clearInterval(timer);
    timer = null;
    host?.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => dialog.close());
    tasks.hide();
    host?.remove();
    container = host = null;
    pending = null;
    ready = false;
    busy = false;
  }
  function show(element: HTMLElement) {
    if (container === element && host?.isConnected) return;
    hide();
    controller = new AbortController();
    container = element;
    host = document.createElement("section");
    host.className = workspace ? "bot-workspace" : "bot-settings";
    element.replaceChildren(host);
    host.setAttribute("aria-busy", "true");
    setMessageHtml(
      host,
      `<header class="resource-heading bot-heading${workspace ? " bot-queue-heading" : ""}"><div>${workspace ? `<div class="bot-title-row"><h1>${h("cli.botWorkspace")}</h1><button type="button" class="wb-button bot-help-button" data-queue-help ${attributes("aria-label", "cli.botQueueHelp")} ${attributes("title", "cli.botQueueHelp")}>${icon("circleHelp")}</button></div>` : `<h1>${h("cli.botSettingsTitle")}</h1><p>${h("cli.botSettingsHint")}</p>`}</div><div class="bot-record-actions"><a class="wb-button" href="${workspace ? "/settings/bots" : "/bots"}" data-wb="route" data-route="${workspace ? "/settings/bots" : "/bots"}">${h(workspace ? "cli.botManageLink" : "cli.botOpenDesk")}</a>${!workspace ? button("cli.botRetentionTitle", "data-retention", false, "settings") : ""}<button type="button" class="wb-button bot-refresh-button" data-refresh ${attributes("aria-label", "cli.botRefresh")} ${attributes("title", "cli.botRefresh")}>${icon("refreshCw")}</button></div></header><p class="bot-notice" role="status" aria-live="polite" data-bot-notice hidden></p><div data-bot-content><p role="status" class="bot-loading">${h("cli.botLoading")}</p></div>`,
    );
    host.querySelector<HTMLButtonElement>("[data-queue-help]")?.addEventListener("click", () => {
      botDialog(
        host!,
        context,
        "cli.botQueueHelp",
        null,
        `<p>${h("cli.botWorkspaceHint")}</p><p>${h("cli.botRecentHint")}</p><p>${h("cli.botQueueStatesHelp")}</p>`,
      );
    });
    host
      .querySelector<HTMLButtonElement>("[data-retention]")
      ?.addEventListener("click", () => void context.execute(() => openBotRetention(host!, context)));
    host.querySelector<HTMLButtonElement>("[data-refresh]")!.onclick = () =>
      void context.execute(async () => {
        await context.reload();
        context.notice("");
      });
    void context.execute(context.reload);
    if (workspace)
      timer = setInterval(() => {
        if (!busy && document.visibilityState === "visible" && !host?.querySelector("dialog[open]")) {
          const current = epoch;
          void context.reload().catch(() => {
            if (current === epoch && !controller.signal.aborted) context.notice(t("cli.botLoadFailed"));
          });
        }
      }, 5000);
  }
  return { show, hide };
}
export const createBotSettings = (t: Translate) => createBotPanel(t, false);
export const createBotWorkspace = (t: Translate) => createBotPanel(t, true);
