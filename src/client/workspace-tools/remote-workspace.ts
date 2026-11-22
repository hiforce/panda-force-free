import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { remoteTerminalPath, type RemoteConnection } from "../../shared/workspace-tools/remote.js";
import { escapeHtml } from "../../shared/html.js";
import { busyIndicator } from "../busy-indicator.js";
import { codexIcon } from "../codex-icons.js";
import { requireElement } from "../dom.js";
import { localizeText, messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { remoteApi, RemoteApiError } from "./remote-api.js";
import { editRemote } from "./remote-editor.js";

export function createRemoteWorkspace(t: Translate) {
  let root: HTMLElement | undefined,
    path = "",
    visible: HTMLElement | undefined;
  let loading: AbortController | undefined;
  let closeEditor: (() => void) | undefined;
  let items: RemoteConnection[] = [];
  const msg = (key: MessageId) => messageHtml(key, undefined, t);

  function hide() {
    loading?.abort();
    loading = undefined;
    closeEditor?.();
    closeEditor = undefined;
    root = visible = undefined;
    path = "";
  }
  function renderList() {
    const section = visible;
    const list = requireElement("[data-remote-list]", section) as HTMLElement;
    setMessageHtml(
      list,
      items
        .map((item) => {
          const address = `${item.username}@${item.host.includes(":") ? "[" + item.host + "]" : item.host}:${item.port}`;
          return `<li class="remote-connection-row">
        <span class="remote-node-icon" aria-hidden="true">${codexIcon("terminal")}</span>
        <div class="remote-node-info">
          <strong data-i18n-ignore>${escapeHtml(item.name)}</strong>
          <span data-i18n-ignore>${escapeHtml(address)}</span>
        </div>
        <span class="remote-node-method">${msg(item.method === "password" ? "connections.password" : "remoteTools.sshKey")}</span>
        <div class="remote-node-actions">
          <a class="wb-button" data-remote-terminal href="${remoteTerminalPath(item.id)}" target="_blank" rel="noopener noreferrer">
            ${codexIcon("terminal")}${msg("common.terminal")}${codexIcon("arrowUpRight", "remote-new-tab")}
          </a>
          <button type="button" class="icon-button" data-remote-edit="${item.id}" ${messageAttributes("aria-label", "remoteTools.edit", undefined, t)}>${codexIcon("pencil")}</button>
        </div>
      </li>`;
        })
        .join(""),
    );
    for (const entry of list.querySelectorAll<HTMLButtonElement>("[data-remote-edit]"))
      entry.onclick = () => {
        const profile = items.find((item) => item.id === entry.dataset.remoteEdit);
        if (profile)
          closeEditor = editRemote(
            t,
            () => {
              if (visible !== section) return;
              closeEditor = undefined;
              void refresh();
            },
            profile,
          );
      };
  }
  async function refresh() {
    if (!visible || loading) return;
    const section = visible,
      request = new AbortController();
    loading = request;
    const state = requireElement("[data-remote-state]", section) as HTMLElement;
    const retry = requireElement("[data-remote-retry]", section) as HTMLButtonElement;
    retry.hidden = true;
    state.hidden = false;
    setMessageHtml(state, `${busyIndicator}<span class="sr-only">${msg("remoteTools.loading")}</span>`);
    try {
      const result = await remoteApi.list(request.signal);
      if (request.signal.aborted) return;
      items = result.items;
      renderList();
      state.hidden = Boolean(items.length);
      if (!items.length) localizeText(state, "remoteTools.empty", undefined, t);
    } catch (error) {
      if (!request.signal.aborted) {
        localizeText(
          state,
          error instanceof RemoteApiError ? error.messageId : "remoteTools.unavailable",
          undefined,
          t,
        );
        retry.hidden = false;
      }
    } finally {
      if (loading === request) loading = undefined;
    }
  }
  function show(container: HTMLElement, url: URL) {
    if (root === container && path === url.pathname && visible?.isConnected) return;
    hide();
    root = container;
    path = url.pathname;
    const section = document.createElement("section");
    visible = section;
    container.replaceChildren(section);
    items = [];
    section.className = "remote-workspace";
    setMessageHtml(
      section,
      `<header class="remote-heading">
      <h1>${msg("remoteTools.title")}</h1>
      <button type="button" class="wb-button primary" data-remote-add>${codexIcon("plus")}${msg("remoteTools.add")}</button>
    </header>
    <div class="remote-connections">
      <ul data-remote-list></ul>
      <p role="status" data-remote-state></p>
      <button type="button" class="wb-button" data-remote-retry hidden>${msg("common.retry")}</button>
    </div>`,
    );
    (requireElement("[data-remote-add]", section) as HTMLButtonElement).onclick = () => {
      closeEditor = editRemote(t, () => {
        if (visible !== section) return;
        closeEditor = undefined;
        void refresh();
      });
    };
    (requireElement("[data-remote-retry]", section) as HTMLButtonElement).onclick = () => void refresh();
    void refresh();
  }
  return { show, hide };
}
