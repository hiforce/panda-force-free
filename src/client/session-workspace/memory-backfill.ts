import type { Translate } from "../../shared/i18n/messages.js";
import type { MemoryBackfillTask, MemoryBackfillView } from "../../shared/project-memory/contracts.js";
import { codexIcon } from "../codex-icons.js";
import type { harnessApi } from "../harness/api.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";

const dayMs = 86_400_000;

export function mountMemoryBackfill(
  host: HTMLDetailsElement,
  path: string,
  t: Translate,
  request: ReturnType<typeof harnessApi>,
  signal: AbortSignal,
  refreshContributions: () => Promise<void>,
) {
  setMessageHtml(
    host,
    `<summary>${messageHtml("sessions.memoryBackfill", {}, t)}</summary>
    <p class="session-memory-backfill-status" role="status" tabindex="-1"></p>
    <form class="wb-form" hidden>
      <p>${messageHtml("sessions.memoryBackfillHint", {}, t)}</p>
      <label class="wb-field"><span>${messageHtml("sessions.memoryBackfillPeriod", {}, t)}</span>
        <select name="days">
          <option value="7">${messageHtml("sessions.memoryBackfillDays", { days: 7 }, t)}</option>
          <option value="30">${messageHtml("sessions.memoryBackfillDays", { days: 30 }, t)}</option>
        </select>
      </label>
      <button class="wb-button" type="submit">${codexIcon("play")}${messageHtml("sessions.memoryBackfillStart", {}, t)}</button>
    </form>
    <div class="session-memory-backfill-progress" hidden>
      <progress max="100" ${messageAttributes("aria-label", "sessions.memoryBackfillProgress", {}, t)}></progress>
      <span>${messageHtml("sessions.memoryBackfillUpdated", {}, t)} <time></time></span>
    </div>
    <button type="button" class="wb-button" data-backfill-reload hidden>${messageHtml("common.retry", {}, t)}</button>`,
  );
  const form = host.querySelector<HTMLFormElement>("form")!;
  const period = form.querySelector<HTMLSelectElement>('[name="days"]')!;
  const submit = form.querySelector<HTMLButtonElement>("button")!;
  const reload = host.querySelector<HTMLButtonElement>("[data-backfill-reload]")!;
  const progress = host.querySelector<HTMLProgressElement>("progress")!;
  const time = host.querySelector<HTMLTimeElement>("time")!;
  const status = host.querySelector<HTMLElement>("[role=status]")!;
  const availableText = {
    paused: "sessions.memoryPaused",
    writeDisabled: "sessions.memoryBackfillWriteDisabled",
    boundaryUnavailable: "sessions.memoryBackfillBoundary",
    forbidden: "sessions.memoryBackfillForbidden",
  } as const;
  let current: MemoryBackfillView | undefined;
  let sending = false;
  let reading = false;
  let pending: { from: number; to: number; requestId: string } | undefined;
  let timer: number | undefined;
  const keepChecking = (task: MemoryBackfillTask | null) => task?.state === "queued" || task?.state === "running";
  const clearTimer = () => window.clearTimeout(timer);
  const announce = (text: string) => {
    if (status.textContent !== text) status.textContent = text;
  };
  signal.addEventListener("abort", clearTimer, { once: true });

  function draw() {
    if (!current) return;
    const { task, availability } = current;
    form.hidden = availability !== "available";
    period.disabled = submit.disabled = sending || keepChecking(task);
    const retry = task?.state === "failed" && Number(period.value) * dayMs === task.to - task.from;
    if (submit.dataset.retry !== String(retry)) {
      submit.dataset.retry = String(retry);
      setMessageHtml(
        submit,
        codexIcon("play") + messageHtml(retry ? "common.retry" : "sessions.memoryBackfillStart", {}, t),
      );
    }
    progress.parentElement!.hidden = !task;
    if (task) {
      progress.value = task.progress;
      time.dateTime = new Date(task.updatedAt).toISOString();
      time.textContent = new Intl.DateTimeFormat(document.documentElement.lang, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(task.updatedAt);
    }
    if (availability !== "available") {
      announce(t(availableText[availability]));
      return;
    }
    const percent = task ? new Intl.NumberFormat(document.documentElement.lang).format(task.progress) : "";
    announce(
      !task
        ? ""
        : task.state === "complete"
          ? t("sessions.memoryBackfillComplete", { count: task.added })
          : task.state === "stopped"
            ? t("sessions.memoryBackfillStopped")
            : task.state === "failed"
              ? t("sessions.memoryBackfillFailed")
              : task.state === "queued" && task.progress === 0
                ? t("sessions.memoryBackfillQueued")
                : t("sessions.memoryBackfillRunning", { percent }),
    );
  }

  async function load() {
    if (reading || sending || !host.open || signal.aborted) return;
    clearTimer();
    reading = true;
    reload.hidden = true;
    if (!current) status.textContent = t("common.pageLoading");
    try {
      const next = await request<MemoryBackfillView>(path, "GET", undefined, signal);
      if (signal.aborted) return;
      if (!current && next.task && next.task.to - next.task.from === 30 * dayMs) period.value = "30";
      const previous = current?.task;
      const completed =
        next.task?.state === "complete" &&
        (previous?.state !== "complete" || previous.updatedAt !== next.task.updatedAt);
      current = next;
      draw();
      if (completed) void refreshContributions();
      if (keepChecking(next.task) && host.open) timer = window.setTimeout(() => void load(), 1400);
    } catch (error) {
      if (signal.aborted) return;
      reload.hidden = false;
      status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      reading = false;
    }
  }

  period.onchange = () => {
    pending = undefined;
    draw();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (sending || reading || current?.availability !== "available" || keepChecking(current.task)) return;
    const right = Date.now();
    pending ??= { from: right - Number(period.value) * dayMs, to: right, requestId: globalThis.crypto.randomUUID() };
    sending = true;
    draw();
    status.textContent = t("sessions.memoryBackfillQueued");
    try {
      const task = await request<MemoryBackfillTask>(path, "POST", pending, signal);
      if (signal.aborted) return;
      pending = undefined;
      current = { ...current, task };
      draw();
      if (task.state === "complete") void refreshContributions();
      if (keepChecking(task)) timer = window.setTimeout(() => void load(), 1400);
    } catch (error) {
      if (!signal.aborted) status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      sending = false;
      if (!signal.aborted) {
        period.disabled = submit.disabled = keepChecking(current.task);
        if (keepChecking(current.task) && host.open) status.focus({ preventScroll: true });
      }
    }
  };
  reload.onclick = () => void load();
  host.ontoggle = () => (host.open ? void load() : clearTimer());
}
