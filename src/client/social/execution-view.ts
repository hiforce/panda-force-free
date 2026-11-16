import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { JsonValue, WorkflowRecord } from "../../shared/delivery/workflow.js";
import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml as m } from "../i18n.js";
import { recoveryView } from "./recovery-view.js";
import { relatedPlan } from "./continuation-view.js";

function receipt(t: Translate, value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (Array.isArray(value.posts)) return value.posts.map((post) => receipt(t, post)).join("");
  const post = typeof value.postId === "string" && /^[0-9]{1,19}$/.test(value.postId) ? value.postId : null;
  return post
    ? `<a target="_blank" rel="noopener noreferrer" href="https://x.com/i/web/status/${post}">${m("social.openPost", undefined, t)} · ${post}</a>`
    : typeof value.articleId === "string"
      ? `<p>${m("social.draftId", undefined, t)}: <code data-i18n-ignore>${e(value.articleId)}</code></p>`
      : "";
}
function stepLabel(t: Translate, key: string) {
  const match = /^post\.(\d+)(?:\.g\d+)?$/.exec(key);
  const media = /^media\.m(\d+)\.g\d+\.(upload|metadata)$/.exec(key);
  if (media)
    return m(media[2] === "upload" ? "social.uploadStep" : "social.metadataStep", { number: Number(media[1]) }, t);
  return match
    ? m("social.postStep", { number: Number(match[1]) }, t)
    : m(key === "article.publish" ? "social.publishStep" : "social.draftStep", undefined, t);
}
/** Render original transport attempts separately from inherited, confirmed results. */
export function executionView(t: Translate, record: WorkflowRecord) {
  const inherited = record.lineage?.steps || [];
  if (!record.steps.length && !inherited.length) return "";
  return `<details class="social-steps" open><summary>${m("social.steps", undefined, t)}</summary>
  ${inherited.length ? `<h4>${m("social.inheritedResults", undefined, t)}</h4><ol class="social-inherited-steps">${inherited.map((step) => `<li><div><span>${stepLabel(t, step.key)}</span><small>${m(step.resolution ? "social.recoveryAdoptedShort" : "social.succeeded", undefined, t)}</small></div>${receipt(t, step.result)}${relatedPlan(t, "social.originalReceipt", step.sourceJobId, record.plan.kind)}</li>`).join("")}</ol>` : ""}
  <ol>${record.steps.map((step) => `<li><div><span>${stepLabel(t, step.key)}</span><span>${m(record.resolutions?.some((item) => item.stepId === step.id) ? "social.recoveryAdoptedShort" : (`social.${step.outcome}` as MessageId), undefined, t)}</span><small>${m("social.attempt", { number: step.attempt }, t)}</small>${step.replacedBy ? `<small>${m("social.replaced", undefined, t)}</small>` : ""}</div>${receipt(t, step.result)}${recoveryView(t, record, step)}</li>`).join("")}</ol></details>`;
}
