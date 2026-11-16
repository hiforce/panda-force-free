import { botTaskState, botCallbackStatus, botTaskDecision } from "../../shared/bots/task-state.js";
import { botTaskAction, botTaskReview } from "../../shared/bots/actions.js";
import type { BotTask } from "../../shared/bots/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { localizeText, setMessageHtml } from "../i18n.js";
import { botUi, botDate, botDecisionLabel, statusIds, type BotContext } from "./ui.js";
import { botDialog, dialogPending } from "./dialog.js";

export async function deleteBotRecord(context: BotContext, id: string, dialog?: HTMLDialogElement) {
  if (!window.confirm(context.t("cli.botConfirmDeleteRecord"))) return;
  await context.execute(async () => {
    if (dialog) dialogPending(dialog, true);
    try {
      await context.api("/tasks/" + id, "DELETE");
      await context.reload();
      dialog?.close();
      context.notice(context.t("cli.botRecordDeleted"));
    } finally {
      if (dialog) dialogPending(dialog, false);
    }
  });
}
export async function openBotTask(host: HTMLElement, context: BotContext, id: string, trigger?: HTMLElement) {
  const { h, button, badge, outcome } = botUi(context.t),
    result = await context.api<{ task: BotTask; events: Array<{ createdAt: number; kind: string; detail: string }> }>(
      "/tasks/" + id,
    );
  if (!host.isConnected) return;
  const { task } = result,
    review = botTaskReview(task),
    decision = botTaskDecision(task);
  const actionName = (actionId: string | null) => {
    const action = actionId ? botTaskAction(task, actionId) : undefined;
    return (task.input.actions !== undefined && action?.label) || botDecisionLabel(actionId, context.t);
  };
  const callbackHtml = (actionId: string | null) => {
    const action = actionId ? botTaskAction(task, actionId) : undefined,
      callback = action?.callback;
    if (!callback) return "";
    return `<details class="bot-task-context bot-action-callback"><summary>${h("cli.botCallbackUrl")}: <span data-i18n-ignore>${e(actionName(actionId))}</span></summary><dl><dt>${h("cli.botCallbackUrl")}</dt><dd data-i18n-ignore>${e(callback.url)}</dd><dt>${h("cli.botCallbackBody")}</dt><dd><pre data-i18n-ignore>${e(JSON.stringify(callback.body, null, 2))}</pre></dd>${callback.success ? `<dt>${h("cli.botCallbackAssertion")}</dt><dd data-i18n-ignore>${e(callback.success.path)} = ${e(JSON.stringify(callback.success.equals))}</dd>` : ""}</dl></details>`;
  };
  const reviewHtml =
    task.status === "review"
      ? `<form data-bot-review class="bot-review-form wb-form"><fieldset class="bot-review-options"><legend>${h("cli.botReviewQuestion")}</legend><p class="bot-review-question" ${review.question && review.question !== "imageConfirmationUnavailable" ? "data-i18n-ignore" : ""}>${review.question === "imageConfirmationUnavailable" ? h("cli.botImageConfirmationUnavailable") : review.question ? e(review.question) : h("cli.botReviewLegacyQuestion")}</p>${review.options.map((option) => `<label class="bot-review-option"><input type="radio" name="pf-bot-review-option" value="${e(option.id)}"><span data-i18n-ignore>${e(option.label)}</span></label>`).join("")}</fieldset><label class="wb-field"><span>${h("cli.botReviewDirection")}</span><textarea name="pf-bot-review-message" rows="3" maxlength="4000" aria-describedby="botReviewDirectionHint"></textarea><small id="botReviewDirectionHint">${h(review.options.length ? "cli.botReviewDirectionHint" : "cli.botReviewLegacyHint")}</small></label><div data-bot-review-callback></div><div class="bot-record-actions"><button type="submit" class="wb-button primary" data-bot-review-submit>${h("cli.botReviewContinue")}</button>${review.options.length ? button("cli.botReviewClearChoice", "data-bot-review-clear") : ""}</div></form>`
      : "";
  const history = task.reviewHistory?.length
    ? `<details class="bot-task-context bot-review-history"><summary>${h("cli.botReviewHistory")}</summary><ol>${task.reviewHistory.map((item) => `<li><p class="bot-review-question" data-i18n-ignore>${e(item.question)}</p>${item.answer.optionId ? `<p data-i18n-ignore>${e(item.options.find((option) => option.id === item.answer.optionId)?.label ?? item.answer.optionId)}</p>` : ""}${item.answer.message ? `<p data-i18n-ignore>${e(item.answer.message)}</p>` : ""}<time>${e(botDate(item.answer.at))}</time></li>`).join("")}</ol></details>`
    : "";
  const resultCard = `<section class="bot-decision"><h3>${h("cli.botResult")}</h3>${outcome(task)}<h3>${h("cli.botDecision")}</h3><p ${task.reason && task.reason !== "imageConfirmationUnavailable" ? "data-i18n-ignore" : ""}>${task.reason === "imageConfirmationUnavailable" ? h("cli.botImageConfirmationUnavailable") : task.reason ? e(task.reason) : h("cli.botUnknown")}</p></section>`;
  const dialog = botDialog(
    host,
    context,
    "cli.botDetails",
    null,
    `${task.title ? `<h3 class="bot-task-title" data-i18n-ignore>${e(task.title)}</h3>` : ""}<div class="bot-detail-summary">${badge(task)}<code data-i18n-ignore>${e(task.externalTaskId)}</code></div>${task.status === "review" ? "" : resultCard}${reviewHtml}${task.status === "review" ? `<details class="bot-task-context"><summary>${h("cli.botDecision")}</summary>${resultCard}</details>` : ""}<p class="bot-callback-state">${h("cli.botCallbackState")}: ${h(({ "not-required": "cli.botCallbackNotRequired", "not-configured": "cli.botCallbackRequired", pending: "cli.botCallbackPending", succeeded: "cli.botCallbackSucceeded", failed: "cli.botCallbackFailed", unknown: "cli.botCallbackUnknown", "not-sent": "cli.botCallbackNotSent" } as const)[botCallbackStatus(task)])}</p><section class="bot-source"><h3>${h("cli.botTaskSource")}</h3><div data-i18n-ignore>${e(task.input.input.text)}</div>${task.input.input.images.length ? `<h4>${h("cli.botImages")}</h4><ul>${task.input.input.images.map((url) => `<li><a href="${e(url)}" target="_blank" rel="noopener noreferrer" data-i18n-ignore>${e(url)}</a></li>`).join("")}</ul>` : ""}</section><details class="bot-task-context"><summary>${h("cli.botTaskContext")}</summary><dl><dt>${h("cli.botInstructions")}</dt><dd data-i18n-ignore>${e(task.input.instructions)}</dd></dl></details>${task.imageEvidence ? `<details class="bot-task-context"><summary>${h("cli.botImageObservations")}</summary><p data-i18n-ignore>${e(task.imageEvidence.observations)}</p><time>${e(botDate(task.imageEvidence.verifiedAt))}</time></details>` : ""}${callbackHtml(decision)}${history}<details class="bot-task-history"><summary>${h("cli.botHistory")}</summary><ol>${result.events.map((event) => `<li><time>${e(botDate(event.createdAt))}</time><div><strong>${e(Object.hasOwn(statusIds, event.kind) ? context.t(statusIds[event.kind as keyof typeof statusIds]) : event.kind)}</strong><p ${event.detail !== "imageConfirmationUnavailable" ? "data-i18n-ignore" : ""}>${event.detail === "imageConfirmationUnavailable" ? h("cli.botImageConfirmationUnavailable") : e(event.detail)}</p></div></li>`).join("")}</ol></details><footer class="bot-dialog-actions"><div class="bot-record-actions">${button("cli.botDeleteRecord", `data-delete-record="${e(task.id)}" ${task.status === "running" ? "disabled" : ""}`, false, "trash")}</div><div class="bot-record-actions">${["created", "running"].includes(botTaskState(task)) ? button("cli.botSuspend", 'data-action="suspend"') : ""}${task.status === "suspended" || (task.failure === "execution" && botTaskState(task) === "error") ? button("cli.botTaskResume", 'data-action="resume"') : ""}${!["finished", "canceled"].includes(botTaskState(task)) ? button("cli.botCancel", 'data-action="cancel"') : ""}${["callback_failed", "callback_unknown"].includes(task.status) ? button("cli.botRetry", 'data-action="retry"', true) : ""}</div></footer>`,
    trigger,
  );
  dialog.classList.add("bot-detail");
  dialog.querySelector<HTMLButtonElement>("[data-delete-record]")!.onclick = () =>
    void deleteBotRecord(context, id, dialog);
  const form = dialog.querySelector<HTMLFormElement>("[data-bot-review]");
  let uncertain = false,
    stale = false;
  let submitted: { reviewId: string; optionId?: string; message?: string } | null = null;
  async function accepted() {
    await context.reload();
    dialog.close();
    context.notice(context.t("cli.botReviewSubmitted"));
  }
  async function reconcile(latest: BotTask) {
    const answer = latest.reviewHistory?.find((item) => item.id === review.id)?.answer;
    if (submitted && answer && answer.optionId === submitted.optionId && answer.message === submitted.message) {
      await accepted();
      return "accepted";
    }
    if (answer || latest.status !== "review" || botTaskReview(latest).id !== review.id) {
      stale = true;
      uncertain = false;
      context.notice(context.t("cli.botReviewStale"));
      return "stale";
    }
    uncertain = false;
    return "pending";
  }
  async function checkReview() {
    const latest = await context.api<{ task: BotTask }>("/tasks/" + id);
    if ((await reconcile(latest.task)) === "pending") context.notice(context.t("cli.botReviewRetryReady"));
  }
  if (form) {
    const message = form.elements.namedItem("pf-bot-review-message") as HTMLTextAreaElement;
    const selected = () => form.querySelector<HTMLInputElement>('input[name="pf-bot-review-option"]:checked');
    const updateCallback = () => {
      const option = review.options.find((item) => item.id === selected()?.value);
      setMessageHtml(
        form.querySelector<HTMLElement>("[data-bot-review-callback]")!,
        callbackHtml(message.value.trim() ? null : (option?.actionId ?? null)),
      );
      message.setCustomValidity("");
    };
    form.addEventListener("change", (event) => {
      if (event.target instanceof HTMLInputElement && event.target.name === "pf-bot-review-option") updateCallback();
    });
    message.addEventListener("input", updateCallback);
    form.querySelector<HTMLButtonElement>("[data-bot-review-clear]")?.addEventListener("click", () => {
      const choice = selected();
      if (choice) choice.checked = false;
      updateCallback();
      message.focus();
    });
    form.onsubmit = (event) => {
      event.preventDefault();
      if (dialog.dataset.pending === "true") return;
      if (stale) {
        void context.execute(async () => {
          dialogPending(dialog, true);
          try {
            await openBotTask(host, context, id, trigger);
            dialog.close();
          } finally {
            dialogPending(dialog, false);
          }
        });
        return;
      }
      const option = review.options.find((item) => item.id === selected()?.value),
        text = message.value.trim();
      if (!uncertain && !option && !text) {
        message.setCustomValidity(context.t("cli.botReviewAnswerRequired"));
        message.reportValidity();
        return;
      }
      if (
        !uncertain &&
        !text &&
        option?.actionId &&
        botTaskAction(task, option.actionId)?.callback &&
        !window.confirm(context.t("cli.botConfirmReviewAction", { action: actionName(option.actionId) }))
      )
        return;
      void context.execute(async () => {
        dialogPending(dialog, true);
        context.notice(context.t(uncertain ? "cli.botReviewChecking" : "cli.botSubmitting"));
        try {
          if (uncertain) {
            await checkReview();
            return;
          }
          submitted = {
            reviewId: review.id,
            ...(option ? { optionId: option.id } : {}),
            ...(text ? { message: text } : {}),
          };
          try {
            await context.api("/tasks/" + id + "/review", "POST", submitted);
          } catch (error) {
            try {
              const latest = await context.api<{ task: BotTask }>("/tasks/" + id);
              if ((await reconcile(latest.task)) !== "pending") return;
            } catch {
              uncertain = true;
              context.notice(context.t("cli.botReviewUnknown"));
              return;
            }
            throw error;
          }
          await accepted();
        } finally {
          dialogPending(dialog, false);
          message.readOnly = uncertain || stale;
          form.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((choice) => {
            choice.disabled = uncertain || stale;
          });
          const clear = form.querySelector<HTMLButtonElement>("[data-bot-review-clear]");
          if (clear) clear.disabled = uncertain || stale;
          localizeText(
            form.querySelector<HTMLButtonElement>("[data-bot-review-submit]")!,
            stale ? "cli.botReviewOpenLatest" : uncertain ? "cli.botReviewCheckStatus" : "cli.botReviewContinue",
            {},
            context.t,
          );
        }
      });
    };
  }
  dialog.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.onclick = () => {
      if (dialog.dataset.pending === "true") return;
      const action = button.dataset.action!,
        lifecycle = ["cancel", "suspend", "resume"].includes(action);
      if (action === "cancel" && !window.confirm(context.t("cli.botConfirmCancel"))) return;
      if (!lifecycle && !window.confirm(context.t("cli.botConfirmRetryAction", { action: actionName(decision) })))
        return;
      void context.execute(async () => {
        dialogPending(dialog, true);
        context.notice(context.t("cli.botSubmitting"));
        try {
          await context.api("/tasks/" + id + "/" + action, "POST", lifecycle ? {} : { confirm: true });
          await context.reload();
          dialog.close();
          context.notice(context.t(lifecycle ? "cli.botLifecycleUpdated" : "cli.botCallbackRetrySubmitted"));
        } finally {
          dialogPending(dialog, false);
        }
      });
    };
  });
}
