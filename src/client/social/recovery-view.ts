import type { Translate } from "../../shared/i18n/messages.js";
import type { WorkflowRecord, WorkflowStep } from "../../shared/delivery/workflow.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";

export function recoveryView(t: Translate, record: WorkflowRecord, step: WorkflowStep) {
  const resolution = record.resolutions?.find((item) => item.stepId === step.id);
  if (resolution) {
    const value = resolution.result,
      post = value && typeof value === "object" && !Array.isArray(value) ? value.postId : null;
    return `<p class="social-recovery-adopted">${m("social.recoveryAdopted", undefined, t)} · <time>${e(new Date(resolution.decidedAt).toLocaleString())}</time>
    ${typeof post === "string" && /^[0-9]{1,19}$/.test(post) ? `<a target="_blank" rel="noopener noreferrer" href="https://x.com/i/web/status/${post}">${m("social.openPost", undefined, t)} · ${post}</a>` : ""}</p>`;
  }
  if (step.outcome !== "pending" || ["running", "queued", "waiting"].includes(record.phase)) return "";
  if (step.operation !== "post.create")
    return `<p class="social-warning">${m("social.recoveryUnsupportedHint", undefined, t)}</p>`;
  const evidence = record.recoveryEvidence?.filter((item) => item.stepId === step.id).at(-1),
    details =
      evidence?.details && typeof evidence.details === "object" && !Array.isArray(evidence.details)
        ? evidence.details
        : null,
    remoteId = details && typeof details.remoteId === "string" ? details.remoteId : "",
    text = details && typeof details.text === "string" ? details.text : "";
  return `<details class="social-recovery" data-recovery-step="${step.id}" ${evidence ? "open" : ""}>
  <summary>${m("social.recoveryTitle", undefined, t)}</summary><p>${m("social.recoveryHint", undefined, t)}</p>
  <label for="socialRecoveryId${step.id}">${m("social.recoveryPostId", undefined, t)}</label>
  <input id="socialRecoveryId${step.id}" data-recovery-id inputmode="numeric" autocomplete="off" maxlength="19" value="${e(remoteId)}">
  <label class="social-recovery-check"><input type="checkbox" data-recovery-costs>${m("social.recoveryCosts", undefined, t)}</label>
  <button type="button" class="wb-button" data-social-action="recovery-inspect">${m("social.recoveryInspect", undefined, t)}</button>
  ${
    evidence
      ? `<section class="social-recovery-result" role="status" data-recovery-status="${evidence.status}"><strong>${m(evidence.status === "match" ? "social.recoveryMatch" : evidence.status === "mismatch" ? "social.recoveryMismatch" : "social.recoveryUnavailable", undefined, t)}</strong>
    <time>${e(new Date(evidence.observedAt).toLocaleString())}</time>${text ? `<pre data-i18n-ignore>${e(text)}</pre>` : ""}
    ${
      evidence.status === "match"
        ? `<p>${m("social.recoveryAdoptHint", undefined, t)}</p><label class="social-recovery-check"><input type="checkbox" data-recovery-accept>${m("social.recoveryAccept", undefined, t)}</label>
    <button type="button" class="wb-button" data-social-action="recovery-adopt" data-evidence="${e(evidence.id)}">${m("social.recoveryAdopt", undefined, t)}</button>`
        : ""
    }</section>`
      : ""
  }</details>`;
}
