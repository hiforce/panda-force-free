import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { PackagePermission } from "../../shared/plugins/contracts.js";
import type { PluginAuditEvent, PluginInstallReview, PluginRegistrySnapshot } from "../../shared/plugins/registry.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";
import { presentationLabel } from "../presentation-labels.js";

const permissions: Record<PackagePermission, MessageId> = {
  "content:templates": "plugins.permissionTemplates",
  "content:site-themes": "plugins.permissionThemes",
  "build:theme-code": "plugins.permissionCode",
};
const actions: Record<PluginAuditEvent["action"], MessageId> = {
  install: "plugins.installed",
  activate: "plugins.activated",
  enable: "plugins.enabled",
  disable: "plugins.disabled",
  exports: "plugins.exportsChanged",
};
export const packageButton = (t: Translate, id: MessageId, action: string, extra = "") =>
  `<button type="button" class="wb-button" data-package-action="${action}" ${extra}>${m(id, undefined, t)}</button>`;
export function packageFrame(t: Translate) {
  return `<header><div><h2>${m("plugins.title", undefined, t)}</h2><p>${m("plugins.subtitle", undefined, t)}</p></div>${packageButton(t, "plugins.close", "close")}</header>
    <p id="packageNotice" role="status"></p><div class="package-library-entry">${packageButton(t, "plugins.libraryTitle", "library")}</div><div class="package-layout"><section class="package-install"><h3>${m("plugins.installTitle", undefined, t)}</h3>
    <label for="packageFile">${m("plugins.chooseFile", undefined, t)}</label><input id="packageFile" type="file" accept="application/json,.json">
    <p>${m("plugins.fileHint", undefined, t)}</p>${packageButton(t, "plugins.review", "review", "disabled")}
    <div id="packageReview"></div></section><section><div class="package-list-heading"><h3>${m("plugins.installedVersions", undefined, t)}</h3>${packageButton(t, "plugins.refresh", "refresh")}</div>
    <p>${m("plugins.activationHint", undefined, t)}</p><div id="packageVersions"></div></section></div>
    <details class="package-audit"><summary>${m("plugins.audit", undefined, t)}</summary><div id="packageAudit"></div></details>`;
}
export function packageReview(t: Translate, review: PluginInstallReview, prefix = "package", submitLabel?: MessageId) {
  const list = (items: PackagePermission[]) =>
    items.length
      ? items.map((item) => `<li>${m(permissions[item], undefined, t)}</li>`).join("")
      : `<li>${m("plugins.none", undefined, t)}</li>`;
  return `<div class="package-review"><h4 data-i18n-ignore>${e(presentationLabel(t, review.manifest))}</h4><p data-i18n-ignore>${e(presentationLabel(t, review.manifest, "description"))}</p>
    <code>${e(review.id)}@${e(review.version)}</code><p>${m("plugins.currentVersion", { version: review.activeVersion || "—" }, t)}</p>
    <p>${m("plugins.contents", { count: review.fileCount, size: (review.byteLength / 1048576).toFixed(2) }, t)}</p><details><summary>SHA-256</summary><code>${e(review.digest)}</code></details>
    <h4>${m("plugins.addedPermissions", undefined, t)}</h4><ul>${list(review.addedPermissions)}</ul><h4>${m("plugins.removedPermissions", undefined, t)}</h4><ul>${list(review.removedPermissions)}</ul>
    <p class="package-trust-notice">${m(review.permissions.includes("build:theme-code") ? "plugins.executionNotice" : "plugins.declarativeNotice", undefined, t)}</p><form id="${prefix}Approval"><label><input type="checkbox" id="${prefix}Accept" required>${m("plugins.acceptPermissions", undefined, t)}</label>
    <ul>${list(review.permissions)}</ul><button type="submit" class="wb-button primary">${m(submitLabel || (review.installed ? "plugins.verifyInstalled" : "plugins.installApproved"), undefined, t)}</button></form></div>`;
}
export function packageVersions(t: Translate, snapshot: PluginRegistrySnapshot) {
  if (!snapshot.packages.length) return `<p>${m("plugins.noPackages", undefined, t)}</p>`;
  return snapshot.packages
    .map(
      (
        item,
      ) => `<article class="package-version" data-package-identity="${e(item.id)}" tabindex="-1"><div><strong data-i18n-ignore>${e(presentationLabel(t, item.manifest))}</strong><span>${m(item.active ? "plugins.activeVersion" : item.enabled ? "plugins.retainedVersion" : "plugins.disabled", undefined, t)}</span></div>
    <code>${e(item.id)}@${e(item.version)}</code><p data-i18n-ignore>${e(presentationLabel(t, item.manifest, "description"))}</p>
    <details><summary>${m("plugins.details", undefined, t)}</summary><ul>${[...item.manifest.siteThemes.map((entry) => `${entry.engine} · ${entry.name}`), ...item.manifest.channelTemplates.map((entry) => `${entry.name} · ${entry.formats.join(", ")}`)].map((text) => `<li data-i18n-ignore>${e(text)}</li>`).join("")}</ul><code>${e(item.digest)}</code></details>
    <div class="package-version-actions">${item.enabled && !item.active ? packageButton(t, "plugins.activate", "activate", `data-package-id="${e(item.id)}" data-package-version="${e(item.version)}"`) : ""}${packageButton(t, item.enabled ? "plugins.disable" : "plugins.enable", item.enabled ? "disable" : "enable", `data-package-id="${e(item.id)}" data-package-version="${e(item.version)}"`)}</div></article>`,
    )
    .join("");
}
export function packageAudit(t: Translate, events: PluginAuditEvent[]) {
  if (!events.length) return `<p>${m("plugins.noEvents", undefined, t)}</p>`;
  return events
    .slice(-20)
    .reverse()
    .map(
      (event) =>
        `<p>${m(actions[event.action], undefined, t)} · <code>${e(event.id)}@${e(event.version)}</code><br><small>${e(new Date(event.createdAt).toLocaleString())} · ${e(event.actor.slice(0, 12))}</small></p>`,
    )
    .join("");
}
