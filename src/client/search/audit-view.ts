import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { SearchAuditStatus } from "../../shared/search/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { SearchStatus } from "./api.js";
const statuses: Record<SearchAuditStatus, MessageId> = {
  healthy: "search.auditHealthy",
  partial: "search.auditPartial",
  missing: "search.auditMissing",
  corrupt: "search.auditCorrupt",
  unverified: "search.auditUnverified",
  outdated: "search.auditOutdated",
  unavailable: "search.auditUnavailable",
  forbidden: "search.auditForbidden",
  superseded: "search.auditSuperseded",
};
export function searchAuditHtml(status: SearchStatus, t: Translate, locale: string) {
  const audit = status.audit,
    report = audit?.latest;
  const state = !status.settings.enabled
    ? "search.auditDisabled"
    : audit?.running
      ? "search.auditRunning"
      : audit?.queued
        ? "search.auditQueued"
        : report
          ? !audit?.current
            ? "search.auditEarlier"
            : (statuses[report.status] ?? "search.auditUnavailable")
          : "search.auditEmpty";
  const checks = report?.checks ?? [],
    coverage: string[] = [];
  if (checks.includes("text.bytes")) coverage.push(t("search.auditLocalCoverage"));
  if (checks.includes("text.all-records")) coverage.push(t("search.auditEsCoverage"));
  if (checks.some((check) => check.startsWith("vector."))) coverage.push(t("search.auditVectorCoverage"));
  return `<p role="status">${e(t(state))}</p>${report ? `<dl class="search-audit-facts"><div><dt>${e(t(audit?.current ? "search.auditChecked" : "search.auditPrevious"))}</dt><dd><time datetime="${e(new Date(report.checkedAt).toISOString())}">${e(new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(report.checkedAt))}</time></dd></div><div><dt>${e(t("search.auditCoverage"))}</dt><dd>${e(coverage.join(" · ") || t("search.auditNoCoverage"))}</dd></div><div><dt>${e(t("search.auditRepair"))}</dt><dd>${e(t(report.repairQueued ? "search.auditRepairQueued" : "search.auditNoRepair"))}</dd></div></dl>` : ""}`;
}
