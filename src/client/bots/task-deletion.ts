import type { BotTaskSummary, BotQueueSnapshot, BotBulkDeleteResult } from "../../shared/bots/contracts.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { botDialog, dialogPending } from "./dialog.js";
import { botUi, type BotContext } from "./ui.js";

export function createBotTaskDeletion(context: BotContext, query: () => string, redraw: () => void) {
  const selected = new Set<string>(),
    { h, attributes, button } = botUi(context.t);
  let active = false,
    busy = false;
  async function collect() {
    const params = new URLSearchParams(query());
    params.set("page", "1");
    params.set("limit", "100");
    params.set("anchor", "0");
    const ids = new Set<string>();
    for (let page = 1; ; page++) {
      params.set("page", String(page));
      const result = await context.api<BotQueueSnapshot>("/queue?" + params);
      if (page === 1) params.set("anchor", String(result.anchor ?? 0));
      for (const task of result.tasks) ids.add(task.id);
      if (ids.size > 10000) throw Error("bulkDeleteLimit");
      if (!result.tasks.length || page * 100 >= (result.total ?? result.tasks.length)) break;
    }
    return [...ids];
  }
  async function open(host: HTMLElement, all: boolean, trigger: HTMLElement) {
    if (busy) return;
    busy = true;
    trigger.setAttribute("aria-busy", "true");
    try {
      const scope = new URLSearchParams(query());
      const ids = all ? await collect() : [...selected];
      const current = new URLSearchParams(query());
      if (!host.isConnected || ["filter", "bot", "q"].some((k) => scope.get(k) !== current.get(k))) return;
      if (!ids.length) {
        context.notice(context.t("cli.botDeleteNone"));
        return;
      }
      const dialog = botDialog(
        host.parentElement!,
        context,
        "cli.botBulkDelete",
        null,
        `<p>${e(context.t("cli.botDeleteCount", { count: String(ids.length) }))}</p><p class="bot-recovery-hint">${h("cli.botDeleteBatchHint")}</p><footer class="bot-dialog-actions">${button("common.cancel", "data-delete-cancel")}${button("cli.botDeleteRecord", "data-delete-submit", true, "trash")}</footer>`,
        trigger,
      );
      dialog.querySelector<HTMLButtonElement>("[data-delete-cancel]")!.onclick = () => dialog.close();
      let offset = 0,
        removed = 0,
        blocked = 0,
        submitting = false;
      dialog.querySelector<HTMLButtonElement>("[data-delete-submit]")!.onclick = () => {
        if (submitting) return;
        submitting = true;
        dialogPending(dialog, true);
        void (async () => {
          for (; offset < ids.length; offset += 500) {
            const chunk = ids.slice(offset, offset + 500);
            const result = await context.api<BotBulkDeleteResult>("/tasks/delete", "POST", { taskIds: chunk });
            removed += result.deleted + result.alreadyDeleted;
            blocked += result.blocked.length;
            const remaining = new Set(result.blocked.map((task) => task.id));
            for (const id of chunk) if (!remaining.has(id)) selected.delete(id);
          }
          dialog.close();
          context.notice(context.t("cli.botDeleteBatchDone", { deleted: String(removed), blocked: String(blocked) }));
          await context.reload(true);
        })()
          .catch(() => {
            if (offset >= ids.length) {
              context.notice(context.t("cli.botLoadFailed"));
              return;
            }
            setMessageHtml(
              dialog.querySelector<HTMLElement>("[data-bot-dialog-notice]")!,
              h("cli.botDeleteBatchUnknown"),
            );
          })
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
  return {
    get active() {
      return active;
    },
    clear() {
      selected.clear();
      active = false;
    },
    checkbox(task: BotTaskSummary) {
      return `<label class="bot-task-check"><input type="checkbox" data-delete-select="${e(task.id)}" ${selected.has(task.id) ? "checked" : ""} ${attributes("aria-label", "cli.botDeleteSelectTask")}></label>`;
    },
    bind(host: HTMLElement, snapshot: BotQueueSnapshot) {
      const target = host.querySelector<HTMLElement>("[data-bot-deletion]")!;
      function toolbar() {
        const focused =
          document.activeElement instanceof HTMLElement && target.contains(document.activeElement)
            ? [...document.activeElement.attributes].find((attribute) => attribute.name.startsWith("data-delete-"))
                ?.name
            : undefined;
        setMessageHtml(
          target,
          active
            ? `<label class="bot-retry-page"><input type="checkbox" data-delete-page ${snapshot.tasks.length && snapshot.tasks.every((task) => selected.has(task.id)) ? "checked" : ""}><span>${h("cli.botDeleteSelectPage")}</span></label><span class="bot-retry-count" aria-live="polite">${e(context.t("cli.botDeleteSelected", { count: String(selected.size) }))}</span><div class="bot-record-actions">${button("common.cancel", "data-delete-close")}<button class="wb-button" type="button" data-delete-selected ${selected.size ? "" : "disabled"}>${h("cli.botDeleteSelectedAction")}</button>${button("cli.botDeleteAllFiltered", "data-delete-filtered", false, "trash")}</div>`
            : button("cli.botBulkDelete", "data-delete-open", false, "trash"),
        );
        const page = target.querySelector<HTMLInputElement>("[data-delete-page]");
        if (page) {
          page.indeterminate =
            snapshot.tasks.some((task) => selected.has(task.id)) &&
            !snapshot.tasks.every((task) => selected.has(task.id));
          page.onchange = () => {
            for (const task of snapshot.tasks) {
              if (page.checked) selected.add(task.id);
              else selected.delete(task.id);
            }
            redraw();
          };
        }
        target.querySelector<HTMLButtonElement>("[data-delete-open]")?.addEventListener("click", () => {
          active = true;
          redraw();
        });
        target.querySelector<HTMLButtonElement>("[data-delete-close]")?.addEventListener("click", () => {
          active = false;
          selected.clear();
          redraw();
        });
        for (const [attribute, all] of [
          ["data-delete-selected", false],
          ["data-delete-filtered", true],
        ] as const) {
          const b = target.querySelector<HTMLButtonElement>(`[${attribute}]`);
          if (b) b.onclick = () => void context.execute(() => open(host, all, b));
        }
        if (focused) target.querySelector<HTMLElement>(`[${focused}]`)?.focus({ preventScroll: true });
      }
      host.querySelectorAll<HTMLInputElement>("[data-delete-select]").forEach((input) => {
        input.onchange = () => {
          if (input.checked) selected.add(input.dataset.deleteSelect!);
          else selected.delete(input.dataset.deleteSelect!);
          toolbar();
        };
      });
      toolbar();
    },
  };
}
