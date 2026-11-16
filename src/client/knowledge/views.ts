import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { KnowledgeTask, KnowledgeTaskDetail } from "../../shared/knowledge/tasks.js";
import type { KnowledgeReviewDetail } from "./api.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { knowledgeDraftHtml } from "./draft-view.js";
import { knowledgePreviousHtml } from "./previous-view.js";
export type { KnowledgePanelContext } from "./source-types.js";
export { knowledgeSourcesHtml } from "./source-view.js";
const statusKeys = {
  queued: "knowledge.queued",
  running: "knowledge.running",
  waiting: "knowledge.waiting",
  review: "knowledge.review",
  committing: "knowledge.committing",
  completed: "knowledge.completed",
  failed: "knowledge.failed",
  cancelled: "knowledge.cancelled",
  stale: "knowledge.stale",
} as const;
const autoKeys = {
  running: "knowledge.autoRunning",
  passed: "knowledge.autoPassed",
  needsReview: "knowledge.autoNeedsReview",
  failed: "knowledge.autoFailed",
  superseded: "knowledge.autoSuperseded",
} as const;
export function knowledgeTaskOrigin(task: KnowledgeTask, t: Translate) {
  const title = !task.origin
    ? t("knowledge.rulesManualOrigin")
    : task.origin.manual
      ? t("knowledge.rulesAdopted")
      : t("knowledge.rulesOrigin", { revision: task.origin.policyRevision });
  return task.origin && "sourceKind" in task.origin
    ? title + " · " + t(task.origin.sourceKind === "web" ? "creative.web" : "creative.slides")
    : title;
}
export function knowledgeTaskLabel(task: KnowledgeTask, t: Translate) {
  return task.state === "review" && task.automaticReview
    ? t(autoKeys[task.automaticReview.state])
    : t(statusKeys[task.state]);
}
const button = (t: Translate, key: MessageId, name: string, primary = false) =>
  `<button type="button" class="wb-button${primary ? " primary" : ""}" data-knowledge-action="${name}">${e(t(key))}</button>`;
export function knowledgeFrame(t: Translate) {
  return `<header class="knowledge-heading"><div><h2>${e(t("knowledge.title"))}</h2><p>${e(t("knowledge.subtitle"))}</p></div><button type="button" class="wb-button" data-knowledge-close aria-label="${e(t("knowledge.close"))}">${codexIcon("x")}</button></header><div class="knowledge-scroll"><p data-knowledge-notice role="status"></p><nav class="knowledge-sections" aria-label="${e(t("knowledge.title"))}"><button type="button" class="wb-button" data-knowledge-section="tasks" aria-pressed="true">${e(t("knowledge.rulesTasks"))}</button><button type="button" class="wb-button" data-knowledge-section="rules" aria-pressed="false">${e(t("knowledge.rulesTitle"))}</button></nav><div data-knowledge-task-view><section class="knowledge-preference wb-form"><label class="wb-choice"><input type="checkbox" role="switch" data-knowledge-automatic disabled><span>${e(t("knowledge.automatic"))}</span></label><p data-knowledge-policy-hint>${e(t("knowledge.manualHint"))}</p><small>${e(t("knowledge.scopeHint"))}</small></section><div class="knowledge-layout"><section><form class="wb-form" data-knowledge-compose><h3>${e(t("knowledge.sources"))}</h3><fieldset class="wb-form" data-source-fields><label class="wb-field"><span>${e(t("knowledge.sourceType"))}</span><select data-source-kind><option value="document">${e(t("knowledge.sourceDocuments"))}</option><option value="web">${e(t("creative.web"))}</option><option value="slides">${e(t("creative.slides"))}</option></select></label><label class="wb-field"><span>${e(t("knowledge.sourceSearch"))}</span><input type="search" data-knowledge-filter maxlength="200" placeholder="${e(t("knowledge.sourceSearch"))}"></label><p data-source-notice role="status"></p><details data-source-selected><summary data-source-summary></summary><div class="knowledge-source-list" data-source-selected-list></div><button type="button" class="wb-button" data-source-clear>${e(t("knowledge.sourceClear"))}</button></details><div class="knowledge-source-list" data-knowledge-sources></div><p data-source-page role="status"></p><div class="resource-actions"><button type="button" class="wb-button" data-source-previous>${e(t("knowledge.sourcePrevious"))}</button><button type="button" class="wb-button" data-source-next>${e(t("knowledge.sourceNext"))}</button><button type="button" class="wb-button" data-source-reload>${e(t("knowledge.rulesReloadSources"))}</button></div></fieldset><small>${e(t("knowledge.savedOnly"))}</small><label class="wb-field"><span>${e(t("knowledge.purpose"))}</span><textarea name="pf-knowledge-purpose" rows="3" maxlength="4096" placeholder="${e(t("knowledge.purposeHint"))}"></textarea></label><button type="submit" class="wb-button primary" data-knowledge-submit disabled>${e(t("knowledge.start"))}</button></form><section class="knowledge-history"><header><h3>${e(t("knowledge.recent"))}</h3>${button(t, "knowledge.refresh", "refresh")}</header><div class="resource-actions" data-knowledge-pages hidden><button type="button" class="wb-button" data-knowledge-newer disabled>${e(t("knowledge.newerTasks"))}</button><button type="button" class="wb-button" data-knowledge-older disabled>${e(t("knowledge.olderTasks"))}</button></div><div class="knowledge-task-list" data-knowledge-tasks></div></section></section><section class="knowledge-detail" data-knowledge-detail tabindex="-1"><p>${e(t("knowledge.selectTask"))}</p></section></div></div><div data-knowledge-rule-view hidden></div></div>`;
}
export function knowledgeTasksHtml(tasks: KnowledgeTask[], selected: string, t: Translate) {
  return tasks.length
    ? tasks
        .map(
          (task) =>
            `<button type="button" class="knowledge-task" data-knowledge-task="${e(task.id)}" aria-pressed="${task.id === selected}"><strong data-i18n-ignore>${e(task.title)}</strong><span>${e(knowledgeTaskLabel(task, t))}</span><small>${e(knowledgeTaskOrigin(task, t))}</small></button>`,
        )
        .join("")
    : `<p>${e(t("knowledge.empty"))}</p>`;
}
export function knowledgeDetailHtml(detail: KnowledgeTaskDetail, review: KnowledgeReviewDetail, t: Translate) {
  const { task, draft } = detail;
  return `<header><h3 data-i18n-ignore>${e(task.title)}</h3><span class="resource-badge" data-knowledge-task-state>${e(knowledgeTaskLabel(task, t))}</span></header><small>${e(knowledgeTaskOrigin(task, t))}</small>${task.failure === "targetChanged" ? `<p role="status">${e(t("knowledge.targetChanged"))}</p>` : ""}${!detail.sourceCurrent ? `<p role="status">${e(t("knowledge.sourceChanged"))}</p>` : ""}
    ${
      task.state === "waiting"
        ? `<form class="wb-form" data-knowledge-answer>${detail.dialogue.questions
            .filter((q) => !detail.dialogue.answers.some((a) => a.questionId === q.id))
            .map(
              (q) =>
                `<label class="wb-field"><span data-i18n-ignore>${e(q.question)}</span><textarea name="pf-knowledge-answer-${e(q.id)}" rows="2" maxlength="8000" required></textarea></label>`,
            )
            .join("")}<button type="submit" class="wb-button primary">${e(t("knowledge.answer"))}</button></form>`
        : ""
    }
    ${knowledgePreviousHtml(detail.previous, t)}${draft ? `<div data-knowledge-draft>${knowledgeDraftHtml(draft, t, { sources: detail.sources })}</div>` : ""}
    ${review.report ? `<details class="knowledge-review-report"><summary>${e(t("knowledge.report"))}</summary><p data-i18n-ignore>${e(review.report.summary)}</p><ul>${review.report.claims.map((claim) => `<li data-i18n-ignore>${e(claim.reason)}</li>`).join("")}</ul>${review.report.issues.map((issue) => `<p data-i18n-ignore>${e(issue)}</p>`).join("")}</details>` : ""}
    <div class="resource-actions" data-knowledge-task-actions>${task.state === "review" && detail.sourceCurrent ? button(t, "knowledge.edit", "edit") + button(t, detail.previous?.reviewRequired ? "knowledge.approveUpdate" : "knowledge.approve", "approve", true) : ""}${["failed", "committing"].includes(task.state) ? button(t, "knowledge.retry", "retry") : ""}${!["completed", "committing", "cancelled"].includes(task.state) ? button(t, "knowledge.cancel", "cancel") : ""}</div>${task.state === "completed" ? `<p>${e(t("knowledge.approved"))}</p>${task.result ? `<a class="wb-button knowledge-record-link" href="${e("/documents?" + new URLSearchParams({ project: task.project, knowledge: task.result.id }))}" data-wb="route" data-route="${e("/documents?" + new URLSearchParams({ project: task.project, knowledge: task.result.id }))}">${e(t("knowledge.openRecord"))}</a>` : ""}` : ""}`;
}
export function knowledgeEditHtml(detail: KnowledgeTaskDetail, t: Translate) {
  const draft = detail.draft!;
  return `<form class="wb-form" data-knowledge-edit><p>${e(t("knowledge.editHint"))}</p><label class="wb-field"><span>${e(t("documents.articleTitle"))}</span><input name="pf-knowledge-title" maxlength="300" required value="${e(draft.title)}"></label><label class="wb-field"><span>${e(t("knowledge.summary"))}</span><textarea name="pf-knowledge-summary" rows="4" maxlength="16000" required>${e(draft.summary)}</textarea></label>${draft.claims.map((claim, i) => `<label class="wb-field"><span data-i18n-ignore>${e(claim.id)}</span><textarea name="pf-knowledge-claim-${i}" rows="3" maxlength="8000" required>${e(claim.text)}</textarea></label>`).join("")}<button type="submit" class="wb-button primary">${e(t("knowledge.saveEdits"))}</button></form>`;
}
