import { deleteAssistant } from "./delete-assistant.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { BotConfig, BotQueueSnapshot } from "../../shared/bots/contracts.js";
import type { BotWorkspaceOverview } from "../../shared/bots/workspace.js";
import type { SettingsPageMount } from "../settings-pages/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { request } from "../http-client.js";
import { busyStatus } from "../busy-indicator.js";
import { setMessageHtml } from "../i18n.js";
import { botAvatarHtml } from "./avatar.js";
import { openBotEditor } from "./editor.js";
import { botUi, type BotContext } from "./ui.js";
import { createBotTaskList } from "./tasks.js";
import { createBotWorkspace as createTaskWorkspace } from "./settings.js";
import { createBotHumanChat, type BotChatDraft } from "./human-chat.js";
import { createBotIntegrations } from "./integrations.js";
import { botHomeHeading, botHomeList } from "./home-view.js";
import { botChatHeading, bindBotChatHeading } from "./chat-heading.js";

export function botRoute(label: string, route: string, primary = false) {
  return `<a class="wb-button${primary ? " primary" : ""}" href="${e(route)}" data-wb="route" data-route="${e(route)}">${label}</a>`;
}

function botIconRoute(t: Translate, id: MessageId, route: string, name: string, selected: boolean) {
  const { h, icon, attributes } = botUi(t);
  return `<a class="wb-button bot-icon-button${selected ? " primary" : ""}" href="${e(route)}" data-wb="route" data-route="${e(route)}" ${attributes("title", id)} ${attributes("aria-label", id)}${selected ? ' aria-current="page"' : ""}>${icon(name)}<span class="sr-only">${h(id)}</span></a>`;
}

/** Home cards, private human chat and task operations have independent lifecycles. */
export function createBotWorkspace(t: Translate) {
  let host: HTMLElement | null = null,
    controller = new AbortController(),
    epoch = 0,
    identity = "",
    route = "/bots",
    timer: ReturnType<typeof setInterval> | undefined,
    currentBot: BotConfig | undefined,
    search = "",
    fingerprint = "",
    loading: Promise<void> | null = null,
    searchTimer: ReturnType<typeof setTimeout> | undefined;
  const drafts = new Map<string, BotChatDraft>(),
    { h, iconButton } = botUi(t);
  let queue = createTaskWorkspace(t);
  let integrationView: ReturnType<typeof createBotIntegrations> | undefined;
  let chatHeading: ReturnType<typeof bindBotChatHeading> | undefined;
  let tasks: ReturnType<typeof createBotTaskList> | undefined, chat: ReturnType<typeof createBotHumanChat> | undefined;
  const context: BotContext = {
    t,
    async api<T>(path = "", method = "GET", body?: unknown): Promise<T> {
      const signal = controller.signal,
        response = await request("/api/bots" + path, {
          method,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        }),
        value = await response.json();
      signal.throwIfAborted();
      if (!response.ok) throw new Error(value.error?.code ?? "unavailable");
      return value;
    },
    notice(message) {
      const target =
        host?.querySelector<HTMLElement>("dialog[open] [data-bot-dialog-notice]") ??
        host?.querySelector<HTMLElement>("[data-bot-notice]");
      if (target) {
        target.textContent = message;
        target.hidden = !message;
      }
    },
    async execute(work) {
      const current = epoch;
      try {
        await work();
      } catch (error) {
        if (current !== epoch || controller.signal.aborted) return;
        const code = error instanceof Error ? error.message : "";
        const errors: Record<string, MessageId> = {
          botBusy: "cli.botAssistantBusy",
          chatBusy: "bots.chatBusy",
          chatContextUnavailable: "bots.chatContextUnavailable",
          staleConversation: "bots.staleConversation",
          idempotencyConflict: "bots.idempotencyConflict",
          invalidInput: "bots.invalidInput",
          conflict: "bots.conflict",
          notFound: "cli.botNotFound",
          invalidAvatar: "cli.botAvatarInvalid",
          avatarBusy: "cli.botAvatarBusy",
          integrationBusy: "bots.integrationBusy",
          staleIntegration: "bots.integrationStale",
          staleConnection: "bots.integrationStale",
          invalidIntegration: "bots.integrationInvalid",
          invalidConnection: "bots.integrationInvalid",
          invalidSchedule: "bots.integrationInvalid",
          invalidMailPolicy: "bots.integrationInvalid",
          invalidDelivery: "bots.integrationInvalid",
          autoReplyConfirmationRequired: "bots.autoConsent",
          connectionUnavailable: "bots.connectionUnavailable",
          connectionNotFound: "bots.connectionUnavailable",
          connectionRefreshPending: "bots.connectionUnavailable",
          connectionKeyUnavailable: "bots.connectionUnavailable",
          alreadyReplied: "bots.alreadyReplied",
          integrationUnavailable: "bots.integrationError",
          disableConnectionFirst: "bots.disableConnection",
          connectionInUse: "bots.connectionUnavailable",
          callbackHostDenied: "cli.botCallbackHostDenied",
        };
        context.notice(t(errors[code] ?? "cli.botError"));
      }
    },
    reload() {
      if (loading) return loading;
      const current = epoch;
      const progress = host?.querySelector<HTMLElement>("[data-bot-loading]");
      if (progress) {
        progress.hidden = false;
        host?.setAttribute("aria-busy", "true");
      }
      loading = load(current).finally(() => {
        if (current !== epoch) return;
        loading = null;
        if (progress) {
          progress.hidden = true;
          host?.removeAttribute("aria-busy");
        }
      });
      return loading;
    },
  };
  function hide() {
    epoch++;
    controller.abort();
    clearInterval(timer);
    timer = undefined;
    loading = null;
    clearTimeout(searchTimer);
    queue.hide();
    chat?.hide();
    chat = undefined;
    chatHeading?.dispose();
    chatHeading = undefined;
    integrationView?.hide();
    integrationView = undefined;
    tasks?.hide();
    tasks = undefined;
    host?.querySelectorAll<HTMLDialogElement>("dialog").forEach((d) => d.close());
    host = null;
    currentBot = undefined;
    fingerprint = "";
  }
  async function load(current: number) {
    const match = /^\/bots\/([a-f0-9-]{36})\/(chat|tasks|integrations)$/.exec(route),
      target = host?.querySelector<HTMLElement>("[data-bot-content]");
    if (!target) return;
    if (match) {
      if (!currentBot) {
        const value = await context.api<{ bot: BotConfig }>("/" + match[1]);
        if (current !== epoch) return;
        currentBot = value.bot;
        const heading = host!.querySelector<HTMLElement>("[data-bot-title]")!;
        heading.textContent = currentBot.name;
        heading.title = currentBot.name;
        host!.querySelector<HTMLElement>("[data-bot-profile]")!.innerHTML = botAvatarHtml(currentBot);
      }
      if (match[2] === "chat") {
        if (!chat) {
          const draft = drafts.get(match[1]!) ?? { text: "", generation: 0 };
          drafts.set(match[1]!, draft);
          chat = createBotHumanChat(context, target, match[1]!, currentBot.name, draft, identity, chatHeading!.actions);
        }
        await chat.reload();
      } else if (match[2] === "tasks") {
        const value = await context.api<BotQueueSnapshot>("/queue?" + tasks!.queryString());
        if (current === epoch) tasks!.render(target, value);
      } else {
        integrationView ??= createBotIntegrations(context, target, match[1]!);
        await integrationView.reload();
      }
    } else if (route === "/bots/tasks") {
      const value = await context.api<BotQueueSnapshot>("/queue?" + tasks!.queryString());
      if (current === epoch) tasks!.render(target, value);
    } else {
      const overview = await context.api<BotWorkspaceOverview>("/workspace");
      if (current !== epoch) return;
      for (const item of host!.querySelectorAll<HTMLElement>("[data-summary]"))
        item.textContent = String(overview.counts[item.dataset.summary as keyof typeof overview.counts]);
      if (target.querySelector("[data-bot-loading]")) context.notice("");
      const next = JSON.stringify([overview.cards, search]);
      if (next === fingerprint) return;
      fingerprint = next;
      const active = target.querySelector<HTMLElement>(":focus"),
        oldKey = active?.dataset.cardAction;
      setMessageHtml(target, botHomeList(overview.cards, search, t));
      target.querySelectorAll<HTMLButtonElement>("[data-delete-assistant]").forEach((b) => {
        b.onclick = () => {
          const card = overview.cards.find((c) => c.bot.id === b.dataset.deleteAssistant);
          if (card) deleteAssistant(host!, context, card.bot);
        };
      });
      target.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach(
        (b) =>
          (b.onclick = () => {
            void context.execute(async () => {
              b.disabled = true;
              try {
                const { bot } = await context.api<{ bot: BotConfig }>("/" + b.dataset.edit);
                if (current === epoch) openBotEditor(host!, context, bot);
              } finally {
                b.disabled = false;
              }
            });
          }),
      );
      target
        .querySelector<HTMLButtonElement>("[data-new-bot]")
        ?.addEventListener("click", () => openBotEditor(host!, context));
      if (oldKey)
        target.querySelector<HTMLElement>(`[data-card-action="${CSS.escape(oldKey)}"]`)?.focus({ preventScroll: true });
    }
    if (current === epoch) host?.removeAttribute("aria-busy");
  }
  return {
    show(container: HTMLElement, options?: SettingsPageMount) {
      hide();
      controller = new AbortController();
      if (identity !== (options?.identity ?? "")) {
        drafts.clear();
        search = "";
        queue = createTaskWorkspace(t);
      }
      identity = options?.identity ?? "";
      route = (options?.route ?? "/bots").split("?")[0]!;
      if (route === "/bots/tasks") {
        queue.show(container);
        return;
      }
      const match = /^\/bots\/([a-f0-9-]{36})\/(chat|tasks|integrations)$/.exec(route),
        home = !match && route !== "/bots/tasks";
      container.innerHTML = "";
      host = document.createElement("section");
      host.className = "bot-workspace bot-home" + (match?.[2] === "chat" ? " bot-home-chat" : "");
      container.append(host);
      host.setAttribute("aria-busy", "true");
      const heading = home
        ? botHomeHeading(t)
        : match?.[2] === "chat"
          ? botChatHeading(t, match[1]!)
          : `<header class="bot-home-heading"><div>${botRoute(h("bots.homeTitle"), "/bots")}
             <div class="bot-title-row"><span data-bot-profile></span><h1 data-bot-title>${h(match?.[2] === "tasks" ? "bots.tasks" : "bots.integrations")}</h1></div>
             <p>${h(match?.[2] === "integrations" ? "bots.integrationHint" : "bots.retainedHint")}</p></div>
             <div class="bot-record-actions">${iconButton("cli.botRefresh", "refreshCw", "data-refresh")}${
               match
                 ? [
                     ["chat", "messageSquare"],
                     ["tasks", "list"],
                     ["integrations", "plug"],
                   ]
                     .map(([section, icon]) =>
                       botIconRoute(
                         t,
                         ("bots." + section) as MessageId,
                         `/bots/${match[1]}/${section}`,
                         icon!,
                         section === match[2],
                       ),
                     )
                     .join("")
                 : ""
             }</div></header>`;
      setMessageHtml(
        host,
        `${heading}<p class="bot-notice" data-bot-notice role="status" hidden></p>
        <div data-bot-content>${home ? `<p class="busy-status busy-status-panel" role="status" data-bot-loading>${busyStatus(t, "common.pageLoading")}</p>` : `<p role="status">${h("settings.pageLoading")}</p>`}</div>`,
      );
      if (match?.[2] === "chat") chatHeading = bindBotChatHeading(host);
      host
        .querySelector<HTMLButtonElement>("[data-new-bot]")
        ?.addEventListener("click", () => openBotEditor(host!, context));
      host.querySelector<HTMLButtonElement>("[data-refresh]")!.onclick = () => {
        if (home) context.notice("");
        void context.execute(context.reload);
      };
      const searchField = host.querySelector<HTMLInputElement>("[data-bot-search]");
      if (searchField) {
        searchField.value = search;
        searchField.oninput = () => {
          search = searchField.value;
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            void context.execute(context.reload);
          }, 250);
        };
      }
      if (route === "/bots/tasks" || match?.[2] === "tasks")
        tasks = createBotTaskList(context, match ? { botId: match[1]! } : undefined);
      void context.execute(context.reload);
      timer = setInterval(
        () => {
          if (document.visibilityState === "visible" && !host?.querySelector("dialog[open]"))
            void context.execute(() => (chat ? chat.reload(true) : context.reload()));
        },
        match?.[2] === "chat" ? 1200 : 5000,
      );
    },
    hide,
  };
}
