import { storageBrowserPath } from "../../shared/workspace-tools/storage-browser.js";
import { storageToolsPath, type RegisteredStorageConnection } from "../../shared/workspace-tools/storage.js";
import { escapeHtml } from "../../shared/html.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { busyIndicator } from "../busy-indicator.js";
import { codexIcon } from "../codex-icons.js";
import { requireElement } from "../dom.js";
import { localizeText, messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { openStorageConnectionEditor, storageProviderIcon, storageProviderLabel } from "./storage-editor.js";
import { StorageConnectionError, storageConnectionsApi } from "./storage-api.js";
import { openStorageDetails } from "./storage-details.js";

const outcomes = {
  cancelled: "storageConnections.googleCancelled",
  expired: "storageConnections.googleExpired",
  failed: "storageConnections.googleFailed",
  saved: "storageConnections.saved",
} as const;

export function createStorageWorkspace(t: Translate) {
  let section: HTMLElement | null = null,
    request: AbortController | null = null,
    closeEditor: (() => void) | null = null;
  const msg = (id: MessageId) => messageHtml(id, undefined, t);
  const actionAttributes = (id: MessageId) =>
    `${messageAttributes("aria-label", id, undefined, t)} ${messageAttributes("title", id, undefined, t)}`;
  const actionLabel = (id: MessageId) => `<span class="storage-tool-action-label">${msg(id)}</span>`;
  function announce(active: HTMLElement, key: MessageId) {
    const result = requireElement("[data-storage-tools-result]", active);
    localizeText(result, key, undefined, t);
    result.hidden = false;
  }
  function hide() {
    request?.abort();
    request = null;
    closeEditor?.();
    closeEditor = null;
    section = null;
  }
  function row(connection: RegisteredStorageConnection) {
    const provider = connection.provider,
      location =
        provider === "google-drive"
          ? connection.account
          : [connection.bucket, connection.region, connection.prefix].filter(Boolean).join(" · "),
      original = provider !== "google-drive" ? connection.originalStorage : undefined,
      placementLabel = original === "active" ? "storageConnections.inUse" : "storageConnections.retained";
    return `<li class="remote-connection-row storage-tool-row">
      <span class="remote-node-icon" aria-hidden="true">${codexIcon(storageProviderIcon[provider])}</span>
      <div class="remote-node-info">
        <strong data-i18n-ignore>${escapeHtml(connection.name)}</strong>
        <span data-i18n-ignore title="${escapeHtml(location)}">${escapeHtml(location)}</span>
      </div>
      <span class="remote-node-method">${msg(storageProviderLabel[provider])}</span>
      <div class="storage-tool-actions">
        ${
          original
            ? `<a class="wb-button" href="/settings/storage" ${actionAttributes(placementLabel)}>
          ${codexIcon("slidersHorizontal", "storage-tool-mobile-glyph")}${actionLabel(placementLabel)}</a>`
            : ""
        }
        ${
          provider !== "google-drive"
            ? `<button type="button" class="wb-button" data-storage-details-id="${escapeHtml(connection.id)}" ${actionAttributes("storageConnections.details")}>
          ${codexIcon("info", "storage-tool-mobile-glyph")}${actionLabel("storageConnections.details")}</button>`
            : ""
        }
        <a class="wb-button storage-tool-browse" href="${storageBrowserPath(connection.id)}" target="_blank" rel="noopener noreferrer" ${actionAttributes("storageBrowser.browse")}>
          ${codexIcon("folderOpen")}${actionLabel("storageBrowser.browse")}${codexIcon("arrowUpRight", "storage-tool-external-glyph")}
        </a>
      </div>
    </li>`;
  }
  async function refresh() {
    if (!section || request) return;
    const active = section,
      current = new AbortController();
    request = current;
    const list = requireElement("[data-storage-tools-list]", active),
      status = requireElement("[data-storage-tools-state]", active),
      retry = requireElement("[data-storage-tools-retry]", active) as HTMLButtonElement,
      add = requireElement("[data-storage-tools-add]", active) as HTMLButtonElement;
    status.hidden = false;
    retry.hidden = true;
    setMessageHtml(status, `${busyIndicator}<span class="sr-only">${msg("storageConnections.loading")}</span>`);
    try {
      const { connections } = await storageConnectionsApi.list(current.signal);
      if (current.signal.aborted) return;
      setMessageHtml(list, connections.map(row).join(""));
      for (const button of list.querySelectorAll<HTMLButtonElement>("[data-storage-details-id]")) {
        const connection = connections.find((value) => value.id === button.dataset.storageDetailsId);
        if (!connection || connection.provider === "google-drive") continue;
        button.onclick = () => {
          closeEditor = openStorageDetails(t, connection, () => {
            if (section !== active) return;
            closeEditor = null;
            announce(active, "storageConnections.keysSaved");
            void refresh();
          });
        };
      }
      add.disabled = false;
      status.hidden = connections.length > 0;
      if (!status.hidden) localizeText(status, "storageConnections.empty", undefined, t);
    } catch (error) {
      if (current.signal.aborted) return;
      const id = error instanceof StorageConnectionError ? error.messageId : "storageConnections.unavailable";
      retry.hidden = id === "storageConnections.administrator";
      localizeText(status, id, undefined, t);
    } finally {
      if (request === current) request = null;
    }
  }
  function show(container: HTMLElement, url: URL) {
    if (section?.parentElement === container) return;
    hide();
    const active = document.createElement("section");
    section = active;
    active.className = "remote-workspace storage-tool-workspace";
    container.replaceChildren(active);
    setMessageHtml(
      active,
      `<header class="remote-heading">
      <div class="storage-tool-heading-copy"><h1>${msg("storageConnections.title")}</h1><p>${msg("storageConnections.description")}</p></div>
      <button type="button" class="wb-button primary" data-storage-tools-add disabled ${actionAttributes("storageConnections.add")}>${codexIcon("plus")}${actionLabel("storageConnections.add")}</button>
    </header>
    <p class="storage-tool-result" role="status" data-storage-tools-result hidden></p>
    <div class="remote-connections">
      <ul ${messageAttributes("aria-label", "storageConnections.title", undefined, t)} data-storage-tools-list></ul>
      <p role="status" data-storage-tools-state></p>
      <button type="button" class="wb-button" data-storage-tools-retry hidden>${msg("common.retry")}</button>
    </div>`,
    );
    const outcome = url.searchParams.get("google");
    if (outcome && Object.hasOwn(outcomes, outcome)) {
      announce(active, outcomes[outcome as keyof typeof outcomes]);
      history.replaceState(history.state, "", storageToolsPath);
    }
    const add = requireElement("[data-storage-tools-add]", active) as HTMLButtonElement;
    add.onclick = () => {
      requireElement("[data-storage-tools-result]", active).hidden = true;
      closeEditor = openStorageConnectionEditor(t, () => {
        if (section !== active) return;
        closeEditor = null;
        announce(active, "storageConnections.saved");
        void refresh();
      });
    };
    (requireElement("[data-storage-tools-retry]", active) as HTMLButtonElement).onclick = () => void refresh();
    void refresh();
  }
  return { show, hide };
}
