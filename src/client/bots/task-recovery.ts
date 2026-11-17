import type { BotBulkRetryRequest, BotBulkRetryResult, BotQueueSnapshot } from "../../shared/bots/contracts.js";
import { botCanRetryExecution } from "../../shared/bots/recovery.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { botDialog, dialogPending } from "./dialog.js";
import { botUi, type BotContext } from "./ui.js";

export function createBotTaskRecovery(context: BotContext, currentQuery: () => string) {
  const selected = new Set<string>(),
    { h, attributes, icon, button } = botUi(context.t);
  let pending: BotBulkRetryRequest | null = null,
    busy = false;
  function checkbox(task: BotQueueSnapshot["tasks"][number]) {
    return botCanRetryExecution(task)
      ? `<label class="bot-task-check"><input type="checkbox" data-retry-select="${e(task.id)}" ${selected.has(task.id) ? "checked" : ""} ${attributes("aria-label", "cli.botRetrySelectTask")}></label>`
      : "";
  }
  async function collect() {
    const params = new URLSearchParams(currentQuery());
    params.set("filter", "error");
    params.set("limit", "100");
    params.set("page", "1");
    params.set("anchor", "0");
    const ids = new Set<string>();
    for (let page = 1; ; page++) {
      params.set("page", String(page));
      const snapshot = await context.api<BotQueueSnapshot>("/queue?" + params);
      if (page === 1) params.set("anchor", String(snapshot.anchor ?? 0));
      for (const task of snapshot.tasks) if (botCanRetryExecution(task)) ids.add(task.id);
      if (ids.size > 500) throw Error("bulkRetryLimit");
      if (page * 100 >= (snapshot.total ?? snapshot.tasks.length) || !snapshot.tasks.length) break;
    }
    return [...ids];
  }
  async function open(host: HTMLElement, all: boolean, trigger: HTMLElement) {
    if (busy) return;
    busy = true;
    trigger.setAttribute("aria-busy", "true");
    try {
      const scope = new URLSearchParams(currentQuery());
      const taskIds = pending?.taskIds ?? (all ? await collect() : [...selected]);
      const latest = new URLSearchParams(currentQuery());
      if (!host.isConnected || ["filter", "bot", "q"].some((key) => scope.get(key) !== latest.get(key))) return;
      if (!taskIds.length) {
        context.notice(context.t("cli.botRetryNone"));
        return;
      }
      const request = pending ?? { id: crypto.randomUUID(), taskIds };
      const dialog = botDialog(
        host.parentElement!,
        context,
        "cli.botRetryFailedTitle",
        null,
        `<p class="bot-recovery-hint">${h("cli.botRetryFailedHint")}</p><p data-retry-confirm>${e(context.t("cli.botRetryConfirmCount", { count: String(taskIds.length) }))}</p><footer class="bot-dialog-actions">${button("common.cancel", "data-retry-cancel")}${button("cli.botRetryQueue", "data-retry-confirm-submit", true, "play")}</footer>`,
        trigger,
      );
      dialog.querySelector<HTMLButtonElement>("[data-retry-cancel]")!.onclick = () => dialog.close();
      const submit = dialog.querySelector<HTMLButtonElement>("[data-retry-confirm-submit]")!;
      let submitting = false;
      submit.onclick = () => {
        if (submitting) return;
        submitting = true;
        pending = request;
        dialogPending(dialog, true);
        void (async () => {
          let result: BotBulkRetryResult;
          try {
            result = await context.api<BotBulkRetryResult>("/tasks/retry-failed", "POST", request);
          } catch {
            setMessageHtml(dialog.querySelector<HTMLElement>("[data-bot-dialog-notice]")!, h("cli.botRetryUnknown"));
            return;
          }
          pending = null;
          selected.clear();
          dialog.close();
          context.notice(
            context.t("cli.botRetryQueued", { queued: String(result.queued), skipped: String(result.skipped) }),
          );
          await context.reload(true);
        })()
          .catch(() => context.notice(context.t("cli.botLoadFailed")))
          .finally(() => {
            submitting = false;
            if (dialog.isConnected) dialogPending(dialog, false);
          });
      };
    } finally {
      busy = false;
      trigger.removeAttribute("aria-busy");
    }
  }
  function bind(host: HTMLElement, snapshot: BotQueueSnapshot) {
    const eligible = snapshot.tasks.filter(botCanRetryExecution);
    for (const task of snapshot.tasks) if (!botCanRetryExecution(task)) selected.delete(task.id);
    host.querySelectorAll<HTMLInputElement>("[data-retry-select]").forEach((input) => {
      input.onchange = () => {
        if (input.checked && selected.size >= 500) {
          input.checked = false;
          context.notice(context.t("cli.botRetryLimit"));
          return;
        }
        if (input.checked) selected.add(input.dataset.retrySelect!);
        else selected.delete(input.dataset.retrySelect!);
        toolbar();
      };
    });
    function toolbar() {
      const target = host.querySelector<HTMLElement>("[data-bot-recovery]")!;
      const canFilter = ["", "attention", "error"].includes(new URLSearchParams(currentQuery()).get("filter") ?? "");
      target.hidden = !pending && !selected.size && !eligible.length && !(canFilter && snapshot.counts?.error);
      const active =
        document.activeElement instanceof HTMLElement && target.contains(document.activeElement)
          ? document.activeElement.getAttribute("data-recovery-action")
          : null;
      setMessageHtml(
        target,
        `<label class="bot-retry-page"><input type="checkbox" data-recovery-action="page" ${eligible.length && eligible.every((task) => selected.has(task.id)) ? "checked" : ""} ${eligible.length ? "" : "disabled"}><span>${h("cli.botRetrySelectPage")}</span></label><span class="bot-retry-count" aria-live="polite">${e(context.t("cli.botRetrySelected", { count: String(selected.size) }))}</span><div class="bot-record-actions"><button type="button" class="wb-button" data-recovery-action="selected" ${selected.size || pending ? "" : "disabled"}>${icon("play")}${h(pending ? "cli.botRetrySameBatch" : "cli.botRetrySelectedAction")}</button><button type="button" class="wb-button" data-recovery-action="all" ${pending || (["", "attention", "error"].includes(new URLSearchParams(currentQuery()).get("filter") ?? "") && (snapshot.counts?.error ?? eligible.length)) ? "" : "disabled"}>${icon("refreshCw")}${h("cli.botRetryAllFiltered")}</button></div>`,
      );
      const page = target.querySelector<HTMLInputElement>("[data-recovery-action=page]")!;
      page.indeterminate =
        eligible.some((task) => selected.has(task.id)) && !eligible.every((task) => selected.has(task.id));
      page.onchange = () => {
        for (const task of eligible) {
          if (page.checked) {
            if (selected.size < 500) selected.add(task.id);
          } else selected.delete(task.id);
        }
        host.querySelectorAll<HTMLInputElement>("[data-retry-select]").forEach((input) => {
          input.checked = selected.has(input.dataset.retrySelect!);
        });
        toolbar();
      };
      target.querySelectorAll<HTMLButtonElement>("button[data-recovery-action]").forEach((input) => {
        input.onclick = () => void context.execute(() => open(host, input.dataset.recoveryAction === "all", input));
      });
      if (active)
        target.querySelector<HTMLElement>(`[data-recovery-action="${active}"]`)?.focus({ preventScroll: true });
    }
    toolbar();
  }
  return {
    checkbox,
    bind,
    clear() {
      selected.clear();
    },
  };
}
