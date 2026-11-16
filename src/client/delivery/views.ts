import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { SitePublication, PublicationPhase } from "../../shared/delivery/contracts.js";
import type { PublicationConnection } from "../../shared/connections/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";

export const phases: Record<PublicationPhase, MessageId> = {
  prepared: "delivery.prepared",
  queued: "delivery.queued",
  running: "delivery.running",
  reconciling: "delivery.reconciling",
  published: "delivery.published",
  failed: "delivery.failed",
  cancelled: "delivery.cancelled",
  needsAttention: "delivery.needsAttention",
};
export const button = (t: Translate, id: MessageId, action: string, primary = false) =>
  `<button type="button" class="wb-button${primary ? " primary" : ""}" data-delivery-action="${action}">${m(id, undefined, t)}</button>`;
export const connectionOptions = (items: PublicationConnection[]) =>
  items.map((item) => `<option value="${e(item.id)}">${e(item.name)}</option>`).join("");
export function deliveryFrame(t: Translate, name: string) {
  return `<header class="delivery-heading"><div><span>${m("delivery.title", undefined, t)}</span><h2 data-i18n-ignore>${e(name)}</h2></div>${button(t, "delivery.close", "close")}</header>
    <nav class="delivery-tabs">${button(t, "delivery.history", "history")}${button(t, "delivery.connections", "connections")}${button(t, "accounts.title", "accounts")}</nav>
    <p id="deliveryNotice" role="status" hidden></p>
    <section id="deliveryConnections" hidden><h3>${m("connections.title", undefined, t)}</h3><p>${m("connections.hint", undefined, t)}</p><label for="connectionPicker">${m("connections.choose", undefined, t)}</label><select id="connectionPicker"></select><div id="connectionEditor"></div><p id="connectionNotice" role="status" hidden></p></section>
    <section id="deliveryAccounts" hidden></section>
    <section id="deliveryPublications"><div id="deliveryPreparation"></div><div class="delivery-columns"><aside><div class="delivery-history-heading"><h3>${m("delivery.history", undefined, t)}</h3>${button(t, "delivery.refresh", "refresh")}</div><div id="deliveryHistory"></div></aside><div id="deliveryPlan"></div></div></section>`;
}
export function publicationHistory(t: Translate, items: SitePublication[], selected: string) {
  if (!items.length) return `<p>${m("delivery.noHistory", undefined, t)}</p>`;
  return items
    .map(
      ({ plan, job }) =>
        `<button type="button" data-delivery-action="select" data-id="${e(plan.id)}" class="delivery-history-row ${selected === plan.id ? "selected" : ""}" ${selected === plan.id ? 'aria-current="true"' : ""}><strong>${e(plan.connection.name)}</strong><small>${e(new Date(plan.createdAt).toLocaleString())}</small><span>${m(phases[job.phase], undefined, t)}</span></button>`,
    )
    .join("");
}
export function publicationPlan(t: Translate, record: SitePublication) {
  const { plan, job } = record;
  const row = (id: MessageId, value: string) => `<dt>${m(id, undefined, t)}</dt><dd data-i18n-ignore>${e(value)}</dd>`;
  return `<h3>${m("delivery.plan", undefined, t)}</h3><span class="delivery-phase" data-phase="${job.phase}">${m(phases[job.phase], undefined, t)}</span>
    <p>${m("delivery.files", { count: plan.fileCount, size: (plan.outputBytes / 1048576).toFixed(2) }, t)}</p>
    <dl>${row("delivery.target", plan.connection.name + " · " + plan.connection.publicUrl)}${row("delivery.version", String(plan.connectionVersion))}${row("delivery.servedPath", plan.connection.connector === "sftp-site" ? plan.connection.directory + "/current" : plan.servedPath)}${plan.build.sourceSnapshot ? row("delivery.sourceCommit", plan.build.sourceSnapshot.commit) : ""}${row("delivery.snapshot", plan.fingerprint)}${row("delivery.expires", new Date(plan.expiresAt).toLocaleString())}</dl>
    ${job.error ? '<p id="deliveryJobError" role="alert"></p>' : ""}
    ${job.phase === "needsAttention" ? `<p>${m("delivery.attentionHint", undefined, t)}</p>${button(t, "delivery.reconcile", "reconcile")}${plan.connection.connector === "sftp-site" ? `<p>${m("delivery.remoteRecoveryHint", undefined, t)}</p>${button(t, "delivery.recover", "recover")}` : ""}` : ""}
    <div class="delivery-actions">${job.phase === "prepared" ? button(t, "delivery.publish", "publish", true) : ""}${["prepared", "queued"].includes(job.phase) ? button(t, "delivery.cancel", "cancel") : ""}</div>
    ${job.receipt ? `<section class="delivery-receipt"><h4>${m("delivery.receipt", undefined, t)}</h4><p>${m(job.receipt.verification === "sftp-files" ? "delivery.remoteVerification" : "delivery.localVerification", undefined, t)}</p><p data-i18n-ignore>${e(job.receipt.releaseId)}</p><p>${e(new Date(job.receipt.publishedAt).toLocaleString())}</p><a href="${e(job.receipt.publicUrl)}" target="_blank" rel="noopener noreferrer">${m("delivery.viewSite", undefined, t)}</a></section>` : ""}`;
}
