import type { Translate } from "../../shared/i18n/messages.js";
import type { SearchResourceInventoryView } from "../../shared/search/resource-inventory.js";
import { setMessageHtml } from "../i18n.js";
import { searchRequest } from "./api.js";
import { vectorStorageResultHtml } from "./vector-storage-view.js";

/** Poll only this panel. Uncertain submissions retain their operation identity across navigation and refresh. */
export function bindVectorStorage(host: HTMLElement, t: Translate, parent: AbortSignal) {
  const panel = host.querySelector<HTMLElement>("[data-vector-storage]");
  if (!panel) return { close() {} };
  const connection = panel.querySelector<HTMLSelectElement>("[data-vector-connection]")!,
    button = panel.querySelector<HTMLButtonElement>("[data-vector-check]")!,
    notice = panel.querySelector<HTMLElement>("[data-vector-notice]")!,
    result = panel.querySelector<HTMLElement>("[data-vector-result]")!,
    operations = new Map<string, string>();
  let closing = false,
    pending = false,
    current: SearchResourceInventoryView | null = null,
    epoch = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    read: AbortController | null = null,
    rendered = "";
  const stored = (key: string, value?: string | null) => {
      try {
        if (value === undefined) return sessionStorage.getItem(key);
        if (value === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
      } catch {
        /* Storage preferences are optional in restricted browser contexts. */
      }
      return null;
    },
    previous = stored("panda-vector-connection");
  if (previous && [...connection.options].some((o) => o.value === previous)) connection.value = previous;
  const sync = () => {
      const busy = pending || current?.state === "queued" || current?.state === "running";
      button.disabled = !!busy;
      const uncertain = operations.has(connection.value) || stored("panda-vector-operation:" + connection.value);
      button.textContent = t(
        busy
          ? "search.storageRunning"
          : uncertain || current?.state === "failed"
            ? "search.storageRetry"
            : "search.storageCheck",
      );
      connection.disabled = pending;
    },
    paint = (view: SearchResourceInventoryView) => {
      current = view;
      notice.textContent = "";
      const next = JSON.stringify(view);
      if (next !== rendered) {
        const details = result.querySelector<HTMLDetailsElement>("[data-vector-details]"),
          open = details?.open ?? false,
          focused = document.activeElement === details?.querySelector("summary");
        setMessageHtml(result, vectorStorageResultHtml(view, t, document.documentElement.lang || "en"));
        const replacement = result.querySelector<HTMLDetailsElement>("[data-vector-details]");
        if (replacement) replacement.open = open;
        if (focused) replacement?.querySelector("summary")?.focus({ preventScroll: true });
        rendered = next;
      }
      sync();
    };
  async function refresh() {
    clearTimeout(timer);
    read?.abort();
    read = new AbortController();
    const selected = connection.value,
      generation = epoch,
      request = read;
    try {
      const view = await searchRequest<SearchResourceInventoryView>(
        "/vector-storage?" + new URLSearchParams({ connection: selected }),
        "GET",
        undefined,
        AbortSignal.any([parent, request.signal, AbortSignal.timeout(15000)]),
      );
      if (closing || generation !== epoch || selected !== connection.value) return;
      paint(view);
      if (["queued", "running"].includes(view.state)) timer = setTimeout(() => void refresh(), 1000);
      else if (view.state === "failed" && view.nextAt !== null)
        timer = setTimeout(() => void refresh(), Math.min(15000, Math.max(1000, view.nextAt - Date.now())));
    } catch {
      if (closing || request.signal.aborted || generation !== epoch) return;
      notice.textContent = t("search.storageReadFailed");
      button.disabled = false;
      button.textContent = t("search.storageRetry");
      timer = setTimeout(() => void refresh(), 5000);
    }
  }
  button.onclick = async () => {
    if (pending || closing) return;
    pending = true;
    clearTimeout(timer);
    read?.abort();
    epoch++;
    const selected = connection.value,
      key = "panda-vector-operation:" + selected,
      saved = stored(key),
      operationId =
        operations.get(selected) ??
        (saved && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved)
          ? saved
          : crypto.randomUUID()),
      generation = epoch;
    operations.set(selected, operationId);
    stored(key, operationId);
    notice.textContent = t("search.storageQueued");
    sync();
    try {
      const view = await searchRequest<SearchResourceInventoryView>(
        "/vector-storage/check",
        "POST",
        { connection: selected, operationId },
        AbortSignal.any([parent, AbortSignal.timeout(15000)]),
      );
      operations.delete(selected);
      stored(key, null);
      if (closing || generation !== epoch) return;
      paint(view);
    } catch {
      if (!closing && generation === epoch) notice.textContent = t("search.storageRetryHint");
    } finally {
      if (!closing && generation === epoch) {
        pending = false;
        sync();
        if (!notice.textContent) void refresh();
        else {
          button.disabled = false;
          button.textContent = t("search.storageRetry");
          timer = setTimeout(() => void refresh(), 5000);
        }
      }
    }
  };
  connection.onchange = () => {
    epoch++;
    current = null;
    rendered = "";
    result.replaceChildren();
    stored("panda-vector-connection", connection.value);
    notice.textContent = t("search.loading");
    sync();
    void refresh();
  };
  const close = () => {
    closing = true;
    epoch++;
    clearTimeout(timer);
    read?.abort();
    parent.removeEventListener("abort", close);
  };
  parent.addEventListener("abort", close, { once: true });
  if (parent.aborted) close();
  else void refresh();
  return { close };
}
