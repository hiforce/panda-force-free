import { escapeHtml } from "../../shared/html.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { storageToolsPath } from "../../shared/workspace-tools/storage.js";
import {
  storageBrowserApiPath,
  storageBrowserDownloadPath,
  storageBrowserPath,
  type StorageBrowserEntry,
  type StorageBrowserPage,
} from "../../shared/workspace-tools/storage-browser.js";
import { busyIndicator } from "../busy-indicator.js";
import { codexIcon } from "../codex-icons.js";
import { requireElement } from "../dom.js";
import { request } from "../http-client.js";
import { localizeText, messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { storageProviderIcon, storageProviderLabel } from "./storage-editor.js";

const errors = new Set<MessageId>([
  "storageConnections.administrator",
  "storageBrowser.missing",
  "storageBrowser.denied",
  "storageBrowser.invalidPath",
  "storageBrowser.driveAuthorization",
]);
const text = (value: string) => escapeHtml(value);

export function mountStorageBrowser(root: HTMLElement, connection: string, t: Translate) {
  const msg = (id: MessageId) => messageHtml(id, undefined, t);
  const iconButton = (selector: string, key: MessageId, icon: Parameters<typeof codexIcon>[0]) =>
    `<button type="button" class="wb-button storage-browser-icon-button" ${selector} ${messageAttributes("aria-label", key, undefined, t)} ${messageAttributes("title", key, undefined, t)}>${codexIcon(icon)}</button>`;
  setMessageHtml(
    root,
    `
    <section class="storage-browser" aria-labelledby="storage-browser-title">
      <header class="storage-browser-header">
        <div class="storage-browser-identity">
          <span class="storage-browser-brand" data-browser-provider aria-hidden="true">${codexIcon("database")}</span>
          <div>
            <h1 id="storage-browser-title">${msg("storageBrowser.title")}</h1>
            <p data-browser-location hidden></p>
          </div>
        </div>
        <a class="wb-button storage-browser-back" href="${storageToolsPath}"
          ${messageAttributes("aria-label", "storageBrowser.manage", undefined, t)}
          ${messageAttributes("title", "storageBrowser.manage", undefined, t)}>
          ${codexIcon("arrowLeft")}<span>${msg("storageBrowser.manage")}</span>
        </a>
      </header>
      <div class="storage-browser-panel">
        <header class="storage-browser-toolbar">
          <div class="storage-browser-path">
            ${iconButton("data-browser-up", "storageBrowser.up", "arrowUp")}
            <nav data-browser-crumbs ${messageAttributes("aria-label", "storageBrowser.path", undefined, t)}></nav>
          </div>
          <div class="storage-browser-controls wb-form">
            <label class="storage-browser-filter wb-control-with-icon">${codexIcon("search")}
              <input type="search" data-browser-filter ${messageAttributes("aria-label", "storageBrowser.filter", undefined, t)}
                ${messageAttributes("placeholder", "storageBrowser.filter", undefined, t)} />
            </label>
            ${iconButton("data-browser-refresh", "storageBrowser.refresh", "refreshCw")}
          </div>
        </header>
        <p class="storage-browser-scope" data-browser-scope hidden>${msg("storageBrowser.driveScope")}</p>
        <div class="storage-browser-content" data-browser-content>
          <table class="storage-browser-table" data-browser-table hidden>
            <thead><tr>
              <th scope="col">${msg("storageBrowser.name")}</th>
              <th scope="col" class="storage-browser-size">${msg("storageBrowser.size")}</th>
              <th scope="col" class="storage-browser-modified">${msg("storageBrowser.modified")}</th>
              <th scope="col"><span class="sr-only">${msg("storageBrowser.actions")}</span></th>
            </tr></thead>
            <tbody data-browser-rows></tbody>
          </table>
          <div class="storage-browser-state" data-browser-state></div>
        </div>
        <footer class="storage-browser-footer">
          <span role="status" aria-live="polite" data-browser-count></span>
          <button type="button" class="wb-button" data-browser-more hidden>${msg("storageBrowser.more")}</button>
        </footer>
      </div>
    </section>`,
  );
  const find = <T extends HTMLElement>(query: string) => requireElement(query, root) as T;
  const crumbs = find("[data-browser-crumbs]"),
    title = find("#storage-browser-title"),
    identity = find("[data-browser-location]"),
    up = find<HTMLButtonElement>("[data-browser-up]"),
    refresh = find<HTMLButtonElement>("[data-browser-refresh]"),
    filter = find<HTMLInputElement>("[data-browser-filter]"),
    more = find<HTMLButtonElement>("[data-browser-more]"),
    table = find("[data-browser-table]"),
    rows = find("[data-browser-rows]"),
    content = find("[data-browser-content]"),
    state = find("[data-browser-state]"),
    count = find("[data-browser-count]");
  const locale = document.documentElement.lang,
    date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const decimals = new Map(
    [0, 1, 2, 3].map((index) => [
      index,
      new Intl.NumberFormat(locale, {
        style: "unit",
        unitDisplay: "narrow",
        unit: ["byte", "kilobyte", "megabyte", "gigabyte"][index],
        maximumFractionDigits: index ? 1 : 0,
      }),
    ]),
  );
  let view: StorageBrowserPage | null = null,
    target: StorageBrowserPage | null = null,
    active: AbortController | null = null,
    error: MessageId | null = null,
    retryMore = false;
  const directory = () => new URL(location.href).searchParams.get("folder") ?? "";
  const pagePath = (id: string) =>
    storageBrowserPath(connection) + (id ? "?" + new URLSearchParams({ folder: id }) : "");
  const knownPaths = new Map<string, StorageBrowserPage["path"]>();

  function renderPath() {
    const path = view?.path ?? knownPaths.get(directory()) ?? [];
    const label = target?.provider === "google-drive" ? msg("storageBrowser.myDrive") : msg("storageBrowser.root");
    const link = (id: string, name: string, latest: boolean) =>
      latest
        ? `<span aria-current="location" tabindex="-1">${name}</span>`
        : `<a href="${text(pagePath(id))}" data-browser-folder="${text(id)}">${name}</a>`;
    setMessageHtml(
      crumbs,
      `<ol><li>${link("", label, !directory())}</li>${path
        .map(
          (part, i) => `<li>${codexIcon("chevronRight")}${link(part.id, text(part.name), i === path.length - 1)}</li>`,
        )
        .join("")}</ol>`,
    );
    const current = crumbs.querySelector('[aria-current="location"]');
    current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    up.disabled = !directory();
  }
  function formatSize(bytes?: number) {
    if (bytes === undefined) return "—";
    const index = Math.min(3, Math.floor(Math.log10(bytes || 1) / 3));
    return decimals.get(index)!.format(bytes / 1000 ** index);
  }
  function row(item: StorageBrowserEntry) {
    const downloadUrl = storageBrowserDownloadPath + "?" + new URLSearchParams({ connection, file: item.id });
    const leading =
      item.kind === "folder"
        ? "folder"
        : /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(item.name)
          ? "image"
          : /\.(mp4|webm|mov|mkv)$/i.test(item.name)
            ? "play"
            : "file";
    const name = `<span class="storage-browser-item-icon" aria-hidden="true">${codexIcon(leading)}</span><span class="storage-browser-item-name" title="${text(item.name)}" dir="auto">${text(item.name)}</span>`;
    const modified = item.modified ? date.format(new Date(item.modified)) : "—";
    const action =
      item.kind === "folder"
        ? codexIcon("chevronRight")
        : item.download
          ? `<a class="wb-button storage-browser-row-action" href="${text(downloadUrl)}" download
        ${messageAttributes("aria-label", "storageBrowser.downloadNamed", { name: item.name }, t)} title="${text(t("storageBrowser.download"))}">${codexIcon("download")}</a>`
          : item.openUrl
            ? `<a class="wb-button storage-browser-row-action" href="${text(item.openUrl)}" target="_blank" rel="noopener noreferrer"
        ${messageAttributes("aria-label", "storageBrowser.openNamed", { name: item.name }, t)} title="${text(t("storageBrowser.open"))}">${codexIcon("arrowUpRight")}</a>`
            : "";
    return `<tr data-browser-kind="${item.kind}"><td>${
      item.kind === "folder"
        ? `<a class="storage-browser-item" href="${text(pagePath(item.id))}" data-browser-folder="${text(item.id)}">${name}</a>`
        : `<div class="storage-browser-item">${name}<small>${item.bytes === undefined ? "" : text(formatSize(item.bytes))}</small></div>`
    }</td>
      <td class="storage-browser-size">${text(formatSize(item.bytes))}</td>
      <td class="storage-browser-modified">${text(modified)}</td><td class="storage-browser-action">${action}</td></tr>`;
  }
  function renderList() {
    const query = filter.value.trim().toLocaleLowerCase(locale),
      items = (view?.entries ?? []).filter((entry) => entry.name.toLocaleLowerCase(locale).includes(query));
    const shown = items.sort(
      (a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || collator.compare(a.name, b.name),
    );
    table.hidden = !shown.length;
    const fragment = document.createElement("div");
    setMessageHtml(fragment, `<table><tbody>${shown.map(row).join("")}</tbody></table>`);
    rows.replaceChildren(...requireElement("tbody", fragment).children);
    content.setAttribute("aria-busy", String(Boolean(active)));
    filter.disabled = !view;
    refresh.disabled = Boolean(active);
    more.hidden = !view?.next;
    more.disabled = Boolean(active);
    count.hidden = !view;
    localizeText(count, "storageBrowser.count", { count: shown.length }, t);
    state.hidden = !error && (shown.length > 0 || (Boolean(active) && Boolean(view)));
    if (error) {
      setMessageHtml(
        state,
        `<div role="alert">${msg(error)} <button class="wb-button" type="button" data-browser-retry>${msg("common.retry")}</button></div>`,
      );
      find("[data-browser-retry]").onclick = () => void load(retryMore, true);
    } else if (!state.hidden) {
      const empty = query ? "storageBrowser.noMatches" : "storageBrowser.empty";
      setMessageHtml(
        state,
        active
          ? `<div role="status">${busyIndicator} ${msg("storageBrowser.loading")}</div>`
          : `<div class="storage-browser-empty">${codexIcon("folderOpen")}<strong>${msg(empty)}</strong></div>`,
      );
    }
  }
  async function load(append = false, focus = false) {
    active?.abort();
    const requestController = new AbortController(),
      id = directory(),
      cursor = append ? view?.next || "" : "";
    active = requestController;
    error = null;
    renderPath();
    renderList();
    try {
      const search = new URLSearchParams({ connection, folder: id, cursor });
      const response = await request(storageBrowserApiPath + "?" + search, {
        cache: "no-store",
        signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(35000)]),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(errors.has(result.error?.messageId) ? result.error.messageId : "storageBrowser.unavailable");
      if (requestController.signal.aborted) return;
      const page = result as StorageBrowserPage;
      if (page.provider === "google-drive" && id) page.path = knownPaths.get(id) ?? page.path;
      knownPaths.set(id, page.path);
      if (append && view) {
        const existing = new Set(view.entries.map((item) => item.kind + ":" + item.id));
        page.entries = [...view.entries, ...page.entries.filter((item) => !existing.has(item.kind + ":" + item.id))];
        if (page.next === cursor) page.next = "";
      }
      view = target = page;
      title.textContent = page.name;
      document.title = page.name + " · " + t("storageBrowser.title");
      identity.hidden = false;
      identity.textContent = t(storageProviderLabel[page.provider]) + " · " + page.location;
      find("[data-browser-scope]").hidden = page.provider !== "google-drive";
      setMessageHtml(find("[data-browser-provider]"), codexIcon(storageProviderIcon[page.provider]));
    } catch (failure) {
      if (!requestController.signal.aborted) {
        const message = failure instanceof Error ? (failure.message as MessageId) : "storageBrowser.unavailable";
        error = errors.has(message) ? message : "storageBrowser.unavailable";
        retryMore = append;
      }
    } finally {
      if (active === requestController) {
        active = null;
        renderPath();
        renderList();
        if (focus) {
          const focusTarget = error
            ? find("[data-browser-retry]")
            : crumbs.querySelector<HTMLElement>('[aria-current="location"]');
          focusTarget?.focus({ preventScroll: true });
        }
      }
    }
  }
  function change(id: string) {
    if (id === directory()) return;
    const child = view?.entries.find((item) => item.kind === "folder" && item.id === id);
    if (child && view?.provider === "google-drive" && !knownPaths.has(id))
      knownPaths.set(id, [...view.path, { id, name: child.name }]);
    history.pushState(null, "", pagePath(id));
    reset(true);
  }
  function reset(focus: boolean) {
    view = null;
    filter.value = "";
    window.scrollTo({ top: 0 });
    void load(false, focus);
  }
  root.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[data-browser-folder]");
    if (!link || event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    change(link.dataset.browserFolder ?? "");
  });
  addEventListener("popstate", () => reset(false));
  up.onclick = () =>
    change(
      view?.path.at(-2)?.id ??
        (view?.path.length === 1 && knownPaths.has(directory()) && view.provider !== "google-drive"
          ? ""
          : (view?.parent ?? "")),
    );
  refresh.onclick = () => void load();
  filter.oninput = renderList;
  more.onclick = () => void load(true);
  void load();
}
