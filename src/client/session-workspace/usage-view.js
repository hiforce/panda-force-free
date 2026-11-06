import { escapeHtml } from "../../shared/html.js";
import { messageHtml, setMessageHtml } from "../i18n.js";

/** @param {HTMLElement} root @param {import('../contracts/session-workspace.js').SessionUsageView} usage @param {import('../contracts/platform.js').I18nRuntime} i18n @param {{compact?: boolean}} options */
export function renderSessionUsage(root, usage, i18n, { compact = false } = {}) {
  const { t, format } = i18n;
  const signature = JSON.stringify([usage, i18n.locale, compact]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.classList.toggle("session-usage-compact", compact);
  root.dataset.reported = String(usage.total !== null);
  const exact = (value) => (value === null ? "—" : escapeHtml(format.number(value)));
  const text = (value) =>
    value === null
      ? "—"
      : escapeHtml(format.number(value, compact ? { notation: "compact", maximumFractionDigits: 1 } : undefined));
  const label = (key) => messageHtml(key, undefined, t);
  setMessageHtml(
    root,
    `
    <div class="session-usage-total"><strong title="${exact(usage.total)}">${text(usage.total)}</strong><span>${label("sessionview.tokens")}</span></div>
    <p class="session-caption session-usage-caption">${label(usage.total === null ? "sessionview.unavailable" : "sessionview.cumulative")}</p>
    ${usage.inputPercent !== null ? `<div class="session-token-bar" aria-hidden="true"><span style="width:${usage.inputPercent}%"></span><span style="width:${100 - usage.inputPercent}%"></span></div>` : ""}
    <div class="session-token-breakdown"><div><span><i></i>${label("sessionview.input")}</span><strong title="${exact(usage.input)}">${text(usage.input)}</strong></div><div><span><i></i>${label("sessionview.output")}</span><strong title="${exact(usage.output)}">${text(usage.output)}</strong></div></div>
    <div class="session-cached-input"><span title="${escapeHtml(t("sessionview.cachedHint"))}">${label("sessionview.cachedInput")} ⓘ</span><span title="${exact(usage.cached)}">${text(usage.cached)}</span></div>
    <div class="session-context-usage"><div><span>${label("sessionview.context")}</span><strong>${usage.contextPercent === null ? "—" : escapeHtml(format.percent(usage.contextPercent / 100, { maximumFractionDigits: 0 }))}</strong></div>
      ${usage.contextPercent !== null ? `<div class="session-context-bar" role="meter" aria-label="${escapeHtml(t("sessionview.context"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${usage.contextPercent}"><span style="width:${usage.contextPercent}%"></span></div>` : ""}
      <p class="session-caption">${usage.context === null || usage.window === null ? label("sessionview.contextUnavailable") : escapeHtml(t("sessionview.contextDetail", { used: format.number(usage.context, { notation: "compact", maximumFractionDigits: 1 }), total: format.number(usage.window, { notation: "compact", maximumFractionDigits: 1 }) }))}</p>
    </div>
  `,
  );
}
