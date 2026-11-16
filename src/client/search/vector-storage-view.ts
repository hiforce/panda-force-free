import { escapeHtml as e } from "../../shared/html.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SearchResourceInventoryView, SearchResourceSummary } from "../../shared/search/resource-inventory.js";
import type { SearchCatalog } from "./api.js";
import { searchField } from "./form-fields.js";

export function vectorStorageHtml(catalog: SearchCatalog, t: Translate) {
  const connections = catalog.connections.filter((c) => c.kind === "milvus");
  if (!connections.length) return "";
  return `<section class="search-settings-section" data-vector-storage><div class="resource-heading resource-section-heading"><h2>${e(t("search.storageTitle"))}</h2><button type="button" class="wb-button" data-vector-check disabled>${e(t("search.storageCheck"))}</button></div><p>${e(t("search.storageHint"))}</p><div class="search-form">${searchField(t, "search.storageConnection", `<select class="wb-select" data-vector-connection>${connections.map((c) => `<option value="${e(c.id)}">${e(c.id)}</option>`).join("")}</select>`)}</div><p data-vector-notice role="status">${e(t("search.loading"))}</p><div data-vector-result></div></section>`;
}
const states: Record<SearchResourceInventoryView["state"], MessageId> = {
  idle: "search.storageIdle",
  queued: "search.storageQueued",
  running: "search.storageRunning",
  ready: "search.storageComplete",
  failed: "search.storageFailed",
};
/** Completion describes an inventory pass, not a claim that every retained or missing resource is healthy. */
export function vectorStorageResultHtml(view: SearchResourceInventoryView, t: Translate, locale: string) {
  const number = new Intl.NumberFormat(locale),
    date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    time = (value: number) => `<time datetime="${e(new Date(value).toISOString())}">${e(date.format(value))}</time>`,
    summary = (s: SearchResourceSummary) =>
      e(t("search.storageCounts", { checked: number.format(s.checked), removed: number.format(s.removed) })),
    busy = ["queued", "running"].includes(view.state),
    details: [MessageId, number][] = [
      ["search.storageProtected", view.summary.protected],
      ["search.storageRetained", view.summary.retained],
      ["search.storageMissing", view.summary.missing],
      ["search.storageUnavailable", view.summary.failed],
    ];
  return `<div class="search-build-progress search-storage-status"><p role="status">${e(t(states[view.state]))}</p>${busy ? `<progress aria-label="${e(t("search.storageRunning"))}" max="1"></progress>` : ""}<p>${summary(view.summary)}</p>${view.checkedAt === null ? "" : `<p>${e(t("search.storageCheckedAt"))} ${time(view.checkedAt)}</p>`}<p class="search-build-hint">${e(t(view.automatic ? "search.storageAutomatic" : "search.storageManual"))}</p>${view.failure ? `<p>${e(t(view.failure === "forbidden" ? "search.storageAccessDenied" : "search.storageRetryHint"))}</p>` : ""}${view.state === "failed" && view.nextAt !== null ? `<p>${e(t("search.storageNextRetry"))} ${time(view.nextAt)}</p>` : ""}<details data-vector-details><summary>${e(t("search.storageDetails"))}</summary><dl class="search-audit-facts">${details.map(([key, count]) => `<div><dt>${e(t(key))}</dt><dd>${e(number.format(count))}</dd></div>`).join("")}</dl><p class="search-build-hint">${e(t("search.storageRetainedHint"))}</p></details>${view.previous ? `<p>${e(t("search.storagePrevious"))} ${time(view.previous.completedAt)}<br>${summary(view.previous.summary)}</p>` : ""}</div>`;
}
