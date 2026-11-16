import { escapeHtml as e } from "../../shared/html.js";
import type { Translate, MessageId } from "../../shared/i18n/messages.js";
import type { EditorialJobFailure, EditorialJobState } from "../../shared/editorial/jobs.js";
import { messageHtml as m } from "../i18n.js";
import type { EditorialTasks } from "./tasks.js";
import { reviewButton } from "./views.js";

const states: Record<EditorialJobState, MessageId> = {
  queued: "editorial.jobQueued",
  running: "editorial.jobRunning",
  succeeded: "editorial.jobSucceeded",
  failed: "editorial.jobFailed",
  cancelled: "editorial.jobCancelled",
};
const failures: Record<EditorialJobFailure, MessageId> = {
  interrupted: "editorial.failureInterrupted",
  processorUnavailable: "editorial.failureUnavailable",
  invalidOutput: "editorial.failureInvalid",
  timeout: "editorial.failureTimeout",
  processingFailed: "editorial.failureProcessing",
};
export function modelControls(t: Translate) {
  return `<details class="editorial-model-controls"><summary>${m("editorial.modelReview", undefined, t)}</summary><p>${m("editorial.modelScope", undefined, t)}</p><label for="editorialMode">${m("editorial.processingMode", undefined, t)}</label><select id="editorialMode"><option value="proofread">${e(t("editorial.proofread"))}</option><option value="rewrite">${e(t("editorial.rewrite"))}</option></select><label for="editorialProcessor">${m("editorial.processor", undefined, t)}</label><select id="editorialProcessor" disabled></select><p id="editorialProcessorHint">${m("editorial.loadingProcessors", undefined, t)}</p>${reviewButton(t, "editorial.submitJob", "model-submit")}${reviewButton(t, "editorial.reloadTasks", "model-reload")}<label for="editorialTaskHistory">${m("editorial.taskHistory", undefined, t)}</label><select id="editorialTaskHistory"></select><div id="editorialTask" aria-live="polite"></div></details>`;
}
export function taskView(t: Translate, tasks: EditorialTasks) {
  const job = tasks.state.current;
  if (!job) return "";
  return `<article class="editorial-task" data-editorial-state="${job.state}"><strong>${m(states[job.state], undefined, t)}</strong><small data-i18n-ignore>${e(job.profile.model)}</small><span>${m("editorial.jobAttempts", { count: job.attempts }, t)}</span>${job.failure ? `<p>${m(failures[job.failure], undefined, t)}</p>` : ""}<div class="editorial-task-actions">${["queued", "running"].includes(job.state) ? reviewButton(t, "editorial.cancelJob", "model-cancel") : job.state === "succeeded" ? reviewButton(t, "editorial.viewSuggestions", "model-view") : reviewButton(t, "editorial.retryJob", "model-retry")}</div></article>`;
}
export function taskHistory(t: Translate, tasks: EditorialTasks) {
  return (
    `<option value="">${e(t("editorial.chooseTask"))}</option>` +
    tasks.state.jobs
      .map(
        (job) =>
          `<option value="${e(job.id)}" ${job.id === tasks.state.current?.id ? "selected" : ""}>${e(new Date(job.createdAt).toLocaleString())} · ${e(t(states[job.state]))}</option>`,
      )
      .join("")
  );
}
