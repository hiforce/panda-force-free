import type {
  DatabaseOverview,
  DatabaseOperation,
  DatabaseMigrationPlan,
  DatabaseTargetSummary,
  DatabaseIssue,
} from "../../shared/database/contracts.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { databaseIssueMessage, moduleLabel, stageMessages } from "./messages.js";
export const databaseTarget = (t: Translate, value: DatabaseTargetSummary) =>
  e(t(value.driver === "mysql" ? "database.mysql" : "database.sqlite")) +
  (value.driver === "mysql"
    ? `<span class="database-target-detail" data-i18n-ignore>${e([value.hostname, value.port].filter(Boolean).join(":"))} · ${e(value.database ?? "")}</span>`
    : "");
export function databaseIssues(t: Translate, issues: DatabaseIssue[]) {
  return issues.length
    ? `<ul class="database-issues">${issues.map((issue) => `<li>${e(databaseIssueMessage(t, issue.code))}${issue.module ? ` <span>${e(moduleLabel(t, issue.module))}</span>` : ""}</li>`).join("")}</ul><details class="database-diagnostics"><summary>${e(t("database.diagnostics"))}</summary><ul>${issues.map((issue) => `<li><code data-i18n-ignore>${e([issue.code, issue.module, issue.object].filter(Boolean).join(" · "))}</code></li>`).join("")}</ul></details>`
    : "";
}
const field = (t: Translate, key: MessageId, name: string, type = "text", extra = "") =>
  `<label class="wb-field"><span>${e(t(key))}</span><input data-database-field="${name}" name="pf-database-${name}" type="${type}" ${extra}></label>`;
export function databaseSettingsHtml(t: Translate, overview: DatabaseOverview | null) {
  return `<section class="database-settings" data-database-settings><div class="database-heading"><div><h2 tabindex="-1" data-database-title>${e(t("database.title"))}</h2><p>${e(t("database.intro"))}</p></div><button type="button" class="wb-button" data-database-refresh>${e(t("database.checkStatus"))}</button></div><p class="database-notice" data-database-notice role="status" aria-live="polite"></p><div data-database-summary>${overview ? `<dl class="database-summary"><div><dt>${e(t("database.current"))}</dt><dd>${databaseTarget(t, overview.current)}</dd></div></dl>${overview.bot?.preservedOnMigration && overview.bot.current.driver === "mysql" ? `<p class="database-preserved">${e(t("database.botPreserved"))}</p>` : ""}` : `<p role="status">${e(t("database.loading"))}</p>`}</div><div data-database-operation></div>${
    overview && !overview.administrator
      ? `<p>${e(t("database.managed"))}</p>`
      : overview
        ? `<div data-database-configuration>${
            !overview.readiness.ready
              ? `<aside class="database-readiness"><h3>${e(t("database.notReady"))}</h3><p>${e(t("database.notReadyHint"))}</p><details><summary>${e(t("database.pendingModules", { count: overview.readiness.modules.filter((m) => !m.schema || !m.readWrite || !m.importer).length }))}</summary>${databaseIssues(t, overview.readiness.issues)}<ul>${overview.readiness.modules
                  .filter((m) => !m.schema || !m.readWrite || !m.importer)
                  .map((m) => `<li>${e(t("database.modulePending", { module: moduleLabel(t, m.module) }))}</li>`)
                  .join("")}</ul></details></aside>`
              : ""
          }<form class="wb-form database-form" data-database-form><div><h3>${e(t("database.configure"))}</h3><p>${e(t("database.connectionHint"))}</p><p class="database-hint">${e(t("database.scopeHint"))}</p></div><fieldset data-database-fields><div class="wb-form-grid">${field(t, "database.hostname", "hostname", "text", 'required maxlength="253" autocomplete="off" spellcheck="false"')}${field(t, "database.port", "port", "number", 'required min="1" max="65535" inputmode="numeric"')}${field(t, "database.database", "database", "text", 'required maxlength="64" autocomplete="off" spellcheck="false"')}${field(t, "database.username", "username", "text", 'required maxlength="128" autocomplete="off" spellcheck="false"')}${field(t, "database.password", "password", "password", 'autocomplete="new-password" maxlength="4096" aria-describedby="database-password-hint"')}</div><p id="database-password-hint" class="database-hint">${e(t("database.passwordHint"))}</p><details data-database-advanced><summary>${e(t("database.advanced"))}</summary><div class="wb-form-grid"><label class="wb-field"><span>${e(t("database.tls"))}</span><select data-database-field="tls" name="pf-database-tls"><option value="verify">${e(t("database.tlsVerify"))}</option><option value="disabled">${e(t("database.tlsDisabled"))}</option></select></label>${field(t, "database.caFile", "caFile", "text", 'maxlength="4096" autocomplete="off"')}${field(t, "database.max", "max", "number", 'min="2" max="64" inputmode="numeric"')}${field(t, "database.connectionTimeout", "connectionTimeout", "number", 'min="1" max="30" inputmode="numeric"')}${field(t, "database.idleTimeout", "idleTimeout", "number", 'min="5" max="600" inputmode="numeric"')}</div><p class="database-hint">${e(t("database.tlsHint"))}</p></details><div class="database-actions"><button type="submit" class="wb-button" name="action" value="test" data-database-test>${e(t("database.test"))}</button><button type="submit" class="wb-button primary" name="action" value="plan" data-database-review ${overview.readiness.ready ? "" : "disabled"}>${e(t("database.review"))}</button></div></fieldset></form><div data-database-plan></div></div>`
        : ""
  }</section>`;
}
export function databasePlanHtml(t: Translate, plan: DatabaseMigrationPlan) {
  return `<section class="database-plan" aria-labelledby="database-plan-title"><h3 id="database-plan-title" tabindex="-1">${e(t("database.planTitle"))}</h3><p>${e(t("database.planHint"))}</p><dl class="database-summary"><div><dt>${e(t("database.from"))}</dt><dd>${databaseTarget(t, plan.source)}</dd></div><div><dt>${e(t("database.to"))}</dt><dd>${databaseTarget(t, plan.target)}</dd></div></dl><ul class="database-module-list">${plan.modules.map((m) => `<li><strong>${e(moduleLabel(t, m.module))}</strong><span>${e(t(m.action === "preserve" ? "database.preserve" : "database.copy"))} · ${e(t("database.tables", { count: m.tableCount }))}${m.rows === undefined ? "" : ` · ${e(t("database.rows", { count: m.rows }))}`}</span></li>`).join("")}</ul>${databaseIssues(t, plan.issues)}<div class="database-actions"><button type="button" class="wb-button primary" data-database-migrate ${plan.ready && plan.expiresAt > Date.now() ? "" : "disabled"}>${e(t("database.start"))}</button><button type="button" class="wb-button" data-database-edit>${e(t("database.edit"))}</button></div></section>`;
}
export function databaseOperationHtml(
  t: Translate,
  operation: DatabaseOperation,
  hasToken: boolean,
  completeHint: "database.completeHint" | "database.reconnecting" = "database.completeHint",
) {
  const hint =
    operation.status === "waiting-restart"
      ? "database.restartHint"
      : operation.status === "complete"
        ? completeHint
        : operation.status === "failed"
          ? "database.failedHint"
          : operation.status === "canceled"
            ? "database.canceledHint"
            : "database.runningHint";
  return `<section class="database-operation" data-database-result><h3 tabindex="-1" data-database-operation-title>${e(t(stageMessages[operation.stage] ?? "database.operation"))}</h3><p>${e(t(hint))}</p><dl class="database-summary"><div><dt>${e(t("database.from"))}</dt><dd>${databaseTarget(t, operation.source)}</dd></div><div><dt>${e(t("database.to"))}</dt><dd>${databaseTarget(t, operation.target)}</dd></div></dl><ul class="database-module-list">${operation.modules.map((m) => `<li><strong>${e(moduleLabel(t, m.module))}</strong><span>${e(t(stageMessages[m.stage] ?? "database.stagePending"))} · ${e(m.totalRows === undefined ? t("database.rows", { count: m.rows }) : t("database.rowsTotal", { count: m.rows, total: m.totalRows }))}</span></li>`).join("")}</ul>${operation.error ? databaseIssues(t, [operation.error]) : ""}${!hasToken && operation.status !== "complete" && operation.status !== "canceled" ? `<p>${e(t("database.tokenMissing"))}</p>` : ""}<div class="database-actions">${operation.canRetry ? `<button type="button" class="wb-button primary" data-database-retry ${hasToken ? "" : "disabled"}>${e(t("database.retry"))}</button>` : ""}${operation.canCancel ? `<button type="button" class="wb-button" data-database-cancel ${hasToken ? "" : "disabled"}>${e(t("database.cancel"))}</button>` : ""}<button type="button" class="wb-button" data-database-recover>${e(t("database.checkStatus"))}</button>${operation.status === "complete" || operation.status === "canceled" ? `<button type="button" class="wb-button" data-database-done>${e(t("database.done"))}</button>` : ""}</div></section>`;
}
