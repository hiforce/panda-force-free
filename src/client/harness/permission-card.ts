import type { HarnessPermission } from "../../shared/harness/contracts.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";

/** Protocol option identifiers stay unchanged; the application owns the action labels and layout. */
export function harnessPermissionCard(permission: HarnessPermission, t: Translate, pending: boolean) {
  const headingId = `harness-permission-${permission.id}`;
  return `<section class="approval-card harness-permission" data-harness-permission-card="${escapeHtml(permission.id)}" aria-labelledby="${escapeHtml(headingId)}" aria-busy="${pending}">
    <header class="harness-permission-heading">${codexIcon("shield")}<strong id="${escapeHtml(headingId)}">${escapeHtml(t("harness.permissions"))}</strong><span role="status" data-permission-status ${pending ? "" : "hidden"}>${escapeHtml(t("harness.responding"))}</span></header>
    <p class="harness-permission-preview">${escapeHtml(permission.title)}</p>
    <div class="approval-actions harness-permission-actions"><div class="approval-actions-main">${permission.options
      .filter((option) => option.kind === "allow_once" || option.kind === "reject_once")
      .map(
        (option) =>
          `<button type="button" class="${option.kind === "allow_once" ? "approval-primary" : "approval-deny danger"}" data-harness-permission="${escapeHtml(permission.id)}" data-harness-option="${escapeHtml(option.id)}" title="${escapeHtml(option.name)}" ${pending ? "disabled" : ""}>${escapeHtml(t(option.kind === "allow_once" ? "common.allowOnce" : "common.deny"))}</button>`,
      )
      .join(
        "",
      )}<button type="button" class="approval-leading" data-harness-permission="${escapeHtml(permission.id)}" ${pending ? "disabled" : ""}>${escapeHtml(t("harness.cancel"))}</button></div></div>
    <details class="harness-permission-details" data-permission-details="${escapeHtml(permission.id)}"><summary>${escapeHtml(t("harness.permissionDetails"))}${codexIcon("chevronDown")}</summary><pre tabindex="0"><code>${escapeHtml(permission.title)}</code></pre></details>
  </section>`;
}
