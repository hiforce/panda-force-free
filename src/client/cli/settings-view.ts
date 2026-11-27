import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import type { CliClientKind, CliCapability, CliProjectScope } from "../../shared/cli/contracts.js";
import type { ContentAccessView } from "../../shared/content-access.js";
import { contentAccessSettingsHtml } from "../content-access/settings.js";
export interface ClientAccess {
  id: string;
  name: string;
  kind: CliClientKind;
  projects: string[];
  projectScope?: CliProjectScope;
  capabilities: CliCapability[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}
export const capabilityLabels = {
  "content:read": "cli.read",
  "search:read": "cli.search",
  "knowledge:read": "cli.tasks",
  "knowledge:records:read": "cli.records",
  "knowledge:write": "cli.write",
  "knowledge:approve": "cli.approve",
  "memory:read": "cli.memoryRead",
  "memory:organize": "cli.memoryOrganize",
} as const;
export function cliSettingsView(t: Translate, projects: { id: string; name: string }[], access: ContentAccessView) {
  return `<header class="resource-heading"><div><h1>${e(t("cli.title"))}</h1><p>${e(t("cli.description"))}</p></div><a class="wb-button" href="/api/cli/manual" target="_blank" rel="noopener">${e(t("cli.manual"))}</a></header>
 <p data-cli-notice role="status" aria-live="polite"></p>
 <section class="cli-settings-section"><h2>${e(t("cli.newClient"))}</h2><form data-cli-form class="wb-form">
 <div class="wb-form-grid"><label class="wb-field"><span>${e(t("cli.name"))}</span><input name="pf-cli-name" value="Panda CLI" required maxlength="80" autocomplete="off"></label>
 <label class="wb-field"><span>${e(t("cli.projects"))}</span><select name="pf-cli-project-scope" aria-describedby="cli-project-scope-hint">
 <option value="allAccessible">${e(t("cli.allProjects"))}</option><option value="selected">${e(t("cli.selectedProjects"))}</option></select></label></div>
 <p class="wb-help" id="cli-project-scope-hint">${e(t("cli.allProjectsHint"))}</p>
 <fieldset data-cli-projects hidden disabled><legend>${e(t("cli.selectedProjects"))}</legend>${[{ id: "personal", name: t("cli.personal") }, ...projects.filter((p) => p.id !== "personal")].map((p) => `<label class="wb-choice"><input type="checkbox" name="pf-cli-project" value="${e(p.id)}" ${p.id === "personal" ? "checked" : ""}><span data-i18n-ignore>${e(p.name)}</span></label>`).join("")}</fieldset>
 <details class="cli-client-options"><summary>${e(t("cli.keyOptions"))}</summary>
 <div class="wb-form-grid"><label class="wb-field"><span>${e(t("cli.kind"))}</span><select name="pf-cli-kind"><option value="cli">CLI</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
 <label class="wb-field"><span>${e(t("cli.expiry"))}</span><input type="number" name="pf-cli-expiry" value="30" min="1" max="365" required></label></div>
 <fieldset><legend>${e(t("cli.permissions"))}</legend>${Object.entries(capabilityLabels)
   .map(
     ([id, label]) =>
       `<label class="wb-choice"><input type="checkbox" name="pf-cli-capability" value="${e(id)}" ${["content:read", "search:read", "knowledge:read"].includes(id) ? "checked" : ""}><span>${e(t(label))}</span></label>`,
   )
   .join("")}</fieldset></details>
 <div class="resource-actions"><button type="submit" class="wb-button primary">${e(t("cli.register"))}</button></div></form></section>
 <section class="cli-settings-section" data-cli-secret hidden><h2>${e(t("cli.oneTime"))}</h2><p>${e(t("cli.guide"))}</p><label class="wb-field"><span>${e(t("cli.key"))}</span><input type="password" data-cli-key readonly autocomplete="off"></label><div class="resource-actions"><button type="button" class="wb-button" data-cli-copy>${e(t("cli.copyKey"))}</button><button type="button" class="wb-button" data-cli-download>${e(t("cli.registration"))}</button><button type="button" class="wb-button" data-cli-done>${e(t("cli.done"))}</button></div></section>
 <section class="cli-settings-section"><header class="resource-heading resource-section-heading"><h2>${e(t("cli.clients"))}</h2><button type="button" class="wb-button" data-cli-refresh>${e(t("cli.refresh"))}</button></header><div data-cli-clients></div></section>
 ${contentAccessSettingsHtml(access, t)}`;
}
export function clientCards(t: Translate, clients: ClientAccess[]) {
  return clients.length
    ? clients
        .map(
          (c) =>
            `<article class="publish-object"><header><h2 data-i18n-ignore>${e(c.name)}</h2><span class="resource-badge">${e(t(c.revokedAt !== null ? "cli.revoked" : c.expiresAt <= Date.now() ? "cli.expired" : "cli.active"))}</span></header><p><span data-i18n-ignore>${e(c.kind)}</span> · ${c.projectScope === "allAccessible" ? e(t("cli.allProjects")) : `<span data-i18n-ignore>${e(c.projects.join(", "))}</span>`}</p><p>${c.capabilities.map((cap) => e(t(capabilityLabels[cap]))).join(" · ")}</p><p>${e(t("cli.expires", { date: new Date(c.expiresAt).toLocaleString() }))}<br>${e(c.lastUsedAt === null ? t("cli.neverUsed") : t("cli.used", { date: new Date(c.lastUsedAt).toLocaleString() }))}</p>${c.revokedAt === null ? `<button type="button" class="wb-button" data-cli-revoke="${e(c.id)}">${e(t("cli.revoke"))}</button>` : ""}</article>`,
        )
        .join("")
    : `<p>${e(t("cli.empty"))}</p>`;
}
