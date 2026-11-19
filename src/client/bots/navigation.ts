import type { Translate } from "../../shared/i18n/messages.js";
import type { BotNavigationItem } from "../../shared/bots/workspace.js";
import { escapeHtml as e } from "../../shared/html.js";
import { request } from "../http-client.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import { botAvatarHtml } from "./avatar.js";

/** The shell loads only names and avatars. Task counts, keys and chat history stay out of navigation. */
export function createBotNavigation(
  t: Translate,
  identity: string,
  readIdentity: () => { key: string; canUseBots: boolean },
) {
  const root = document.createElement("div");
  root.className = "bot-sidebar-list";
  let host: HTMLElement | null = null,
    items: BotNavigationItem[] = [],
    active = "",
    fingerprint = "",
    loading: Promise<void> | null = null,
    controller: AbortController | undefined,
    updatedAt = 0,
    failed = false,
    revision = 0,
    refetch = false;
  function owned() {
    const current = readIdentity();
    return current.key === identity && current.canUseBots;
  }
  function render() {
    if (!owned()) {
      items = [];
      root.replaceChildren();
      root.remove();
      return;
    }
    const key = JSON.stringify([items, active, failed]);
    if (key === fingerprint) return;
    fingerprint = key;
    const focused = root.querySelector<HTMLElement>(":focus")?.dataset.botShortcut;
    setMessageHtml(
      root,
      `<div role="list" aria-label="${e(t("bots.sidebarBots"))}" data-pf-aria-label="bots.sidebarBots">${items
        .map((bot) => {
          const route = "/bots/" + bot.id + "/chat",
            selected = active === bot.id;
          return `<div role="listitem"><a href="${route}" data-wb="route" data-route="${route}" data-bot-shortcut="${e(bot.id)}" class="bot-sidebar-link${selected ? " active" : ""}" ${selected ? 'aria-current="page"' : ""} title="${e(bot.name)}">${botAvatarHtml(bot)}<span data-i18n-ignore>${e(bot.name)}</span></a></div>`;
        })
        .join(
          "",
        )}</div>${failed ? `<button type="button" class="wb-button bot-sidebar-retry">${messageHtml("bots.reloadBots", {}, t)}</button>` : ""}`,
    );
    root.querySelector<HTMLButtonElement>("button")?.addEventListener("click", () => {
      void load(true);
    });
    if (focused)
      root.querySelector<HTMLElement>(`[data-bot-shortcut="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  function load(force = false) {
    if (!owned()) {
      controller?.abort();
      render();
      return Promise.resolve();
    }
    if (loading) {
      if (force) refetch = true;
      return loading;
    }
    if (!force && updatedAt && Date.now() - updatedAt < 30000) return Promise.resolve();
    controller = new AbortController();
    const signal = controller.signal,
      currentRevision = revision;
    refetch = false;
    loading = (async () => {
      try {
        const response = await request("/api/bots/navigation", {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) throw new Error("Navigation unavailable");
        const value = (await response.json()) as { bots: BotNavigationItem[] };
        if (!owned() || signal.aborted || currentRevision !== revision) return;
        items = value.bots;
        failed = false;
        updatedAt = Date.now();
      } catch {
        if (owned() && !signal.aborted) failed = true;
      } finally {
        loading = null;
        render();
        if (refetch && owned() && host?.isConnected) void load(true);
      }
    })();
    return loading;
  }
  const changed = () => {
    revision++;
    void load(true);
  };
  window.addEventListener("panda-bots-changed", changed);
  window.addEventListener("focus", () => {
    if (host?.isConnected) void load();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && host?.isConnected) void load();
  });
  return {
    mount(target: HTMLElement | null, route: string) {
      host = target;
      if (!host || !owned()) {
        root.remove();
        return;
      }
      active = /^\/bots\/([a-f0-9-]{36})\//.exec(route)?.[1] ?? "";
      if (root.parentElement !== host) host.append(root);
      render();
      void load();
    },
  };
}
