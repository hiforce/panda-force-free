import { escapeHtml as e } from "../../shared/html.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SearchStatus } from "./api.js";

const phases: Record<string, MessageId> = {
  queued: "search.buildQueued",
  reading: "search.buildReading",
  text: "search.buildText",
  knowledge: "search.buildKnowledge",
  vector: "search.buildVector",
  activating: "search.buildActivating",
  ready: "search.buildReady",
  failed: "search.buildFailed",
};
/** A bar represents only the current measured step; unknown totals remain indeterminate. */
export function searchProgressHtml(status: SearchStatus, t: Translate, locale: string) {
  const p = status.progress;
  if (!p) return "";
  const running = ["queued", "running"].includes(status.state),
    phase = status.state === "queued" ? "queued" : status.state === "failed" ? "failed" : p.phase,
    measured = running && phase !== "queued" && p.total !== null && p.total > 0,
    number = new Intl.NumberFormat(locale),
    date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    time = (value: number) => `<time datetime="${e(new Date(value).toISOString())}">${e(date.format(value))}</time>`;
  return `<section class="search-build-progress"><div class="resource-heading resource-section-heading"><h3>${e(t("search.buildTitle"))}</h3><span role="status">${e(t(phases[phase] ?? "search.buildQueued"))}</span></div>
${running ? `<progress aria-label="${e(t("search.buildCurrentStep"))}" ${measured ? `max="${p.total}" value="${p.completed}"` : 'max="1"'}></progress>` : ""}
${measured ? `<p>${e(t(phase === "vector" ? "search.buildChunkCount" : "search.buildDocumentCount", { count: number.format(p.completed), total: number.format(p.total!) }))}</p>` : ""}
<dl class="search-field-grid search-build-facts"><div><dt>${e(t("search.buildStarted"))}</dt><dd>${p.startedAt ? time(p.startedAt) : e(t("search.buildNotStarted"))}</dd></div><div><dt>${e(t("search.buildUpdated"))}</dt><dd>${time(p.updatedAt)}</dd></div></dl>
<p class="search-build-hint">${e(t("search.buildHint"))}</p></section>`;
}
