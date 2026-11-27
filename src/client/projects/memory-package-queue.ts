import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { MemoryPackageTransfer } from "../../shared/project-memory/archive.js";
import { escapeHtml as escape } from "../../shared/html.js";
import { messageHtml, setMessageHtml } from "../i18n.js";
import { harnessApi } from "../harness/api.js";

const states = {
  uploading: "projects.memoryPackageUploading",
  queued: "projects.memoryPackageQueued",
  checking: "projects.memoryPackageBackgroundCheck",
  "awaiting-key": "projects.memoryPackageReadyToUnlock",
  failed: "projects.memoryPackageTransferFailed",
} as const;

export function memoryPackageQueue(
  section: HTMLElement,
  path: string,
  signal: AbortSignal,
  t: Translate,
  onMode: (remote: boolean) => void,
  choose: (task: MemoryPackageTransfer) => void,
  discard: (task: MemoryPackageTransfer) => Promise<void>,
) {
  const api = harnessApi(t);
  const list = section.querySelector<HTMLElement>("[data-memory-queue-list]")!;
  const status = section.querySelector<HTMLElement>("[role=status]")!;
  const m = (id: MessageId) => messageHtml(id, {}, t);
  let transfers: MemoryPackageTransfer[] = [];
  let signature = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;

  const refresh = async () => {
    if (signal.aborted) return;
    clearTimeout(timer);
    const revision = ++sequence;
    try {
      const response = await api<{ remote: boolean; transfers: MemoryPackageTransfer[] }>(
        path,
        "GET",
        undefined,
        signal,
      );
      if (signal.aborted || revision !== sequence) return;
      onMode(response.remote);
      status.textContent = "";
      transfers = response.transfers;
      section.hidden = !transfers.length;
      const nextSignature = JSON.stringify(transfers);
      if (signature === nextSignature) return;
      signature = nextSignature;
      const active = list.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset
        : undefined;
      const button = (action: "choose" | "retry" | "discard", label: MessageId, task: MemoryPackageTransfer) =>
        `<button type="button" class="wb-button${action === "choose" ? " primary" : ""}" data-package-action="${action}" data-package-task="${escape(task.id)}">${m(label)}</button>`;
      setMessageHtml(
        list,
        transfers
          .map((task) => {
            const eligible = task.state === "uploading" || task.state === "awaiting-key";
            const bytes = task.state === "checking" ? task.checkedBytes : task.offset;
            const progress =
              task.state === "checking" || task.state === "uploading"
                ? `<progress value="${bytes}" max="${task.size}" aria-label="${escape(t(states[task.state]))}"></progress>`
                : "";
            return `<li><div><strong data-i18n-ignore>${escape(task.name)}</strong><br><span>${m(task.unsupported ? "projects.memoryPackageUnsupported" : states[task.state])}</span>${progress}</div>
          <div class="memory-package-queue-actions">
          ${eligible ? button("choose", task.state === "uploading" ? "projects.memoryPackageResume" : "projects.memoryPackageContinue", task) : ""}
          ${task.retryable ? button("retry", "common.retry", task) : ""}
          ${button("discard", "projects.memoryPackageDiscard", task)}</div></li>`;
          })
          .join(""),
      );
      if (active) {
        const restore = [...list.querySelectorAll<HTMLButtonElement>("[data-package-action]")].find(
          (control) =>
            control.dataset.packageTask === active.packageTask &&
            control.dataset.packageAction === active.packageAction,
        );
        restore?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (signal.aborted || revision !== sequence) return;
      section.hidden = false;
      status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      if (
        !signal.aborted &&
        revision === sequence &&
        transfers.some((task) => task.state === "queued" || task.state === "checking")
      )
        timer = setTimeout(() => {
          void refresh();
        }, 1500);
    }
  };

  list.onclick = async (event) => {
    const control =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-package-action]") : null;
    const task = control && transfers.find((item) => item.id === control.dataset.packageTask);
    if (!control || !task || signal.aborted) return;
    if (control.dataset.packageAction === "choose") {
      try {
        choose(task);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
      }
      return;
    }
    control.disabled = true;
    status.textContent = "";
    try {
      if (control.dataset.packageAction === "discard") await discard(task);
      else await api(path + "?" + new URLSearchParams({ upload: task.id, retry: "1" }), "POST", undefined, signal);
      await refresh();
    } catch (error) {
      if (!signal.aborted) status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      control.disabled = false;
    }
  };
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return { refresh };
}
