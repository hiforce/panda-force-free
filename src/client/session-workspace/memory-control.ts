import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import {
  legacyMemoryPath,
  type MemoryLegacySessionView,
  type MemorySessionSummary,
  type MemorySourcePolicy,
} from "../../shared/project-memory/contracts.js";
import { codexIcon } from "../codex-icons.js";
import { conversationsPath, harnessApi } from "../harness/api.js";
import { localizeAttribute, localizeText, messageHtml, setMessageHtml } from "../i18n.js";

type MemoryScope = "managed" | "legacy" | "private" | "unbound";

export function createSessionMemoryControl(host: HTMLElement, t: Translate) {
  const request = harnessApi(t);
  const status = host.querySelector<HTMLElement>("[data-memory-control-status]")!;
  const hint = host.querySelector<HTMLElement>("[data-memory-control-hint]")!;
  const counts = host.querySelector<HTMLElement>("[data-memory-control-counts]")!;
  const contributed = host.querySelector<HTMLElement>("[data-memory-contributed]")!;
  const recalled = host.querySelector<HTMLElement>("[data-memory-recalled]")!;
  const manual = host.querySelector<HTMLElement>("[data-memory-manual-count]")!;
  const settings = host.querySelector<HTMLButtonElement>("[data-memory-control-settings]")!;
  const main = host.querySelector<HTMLButtonElement>("[data-memory-control-main]")!;
  const secondary = host.querySelector<HTMLButtonElement>("[data-memory-control-button]")!;
  let id: string | null = null;
  let scope: MemoryScope | undefined;
  let runStatus = "";
  let cancellation: AbortController | undefined;
  let polling: number | undefined;
  let reading = false;
  let saving = false;

  function button(element: HTMLButtonElement, label: MessageId, icon: string, action?: string) {
    element.hidden = element.disabled = false;
    if (action) element.dataset.sessionAction = action;
    localizeAttribute(element, "aria-label", label, undefined, t);
    localizeAttribute(element, "title", label, undefined, t);
    setMessageHtml(
      element,
      codexIcon(icon) +
        (element === settings ? '<span class="sr-only">' : "<span>") +
        messageHtml(label, {}, t) +
        "</span>",
    );
  }
  function paint(label: MessageId, description?: MessageId, tone?: "active" | "paused") {
    localizeText(status, label, undefined, t);
    status.dataset.tone = tone ?? "";
    hint.hidden = !description;
    if (description) localizeText(hint, description, undefined, t);
    for (const control of [main, secondary, settings]) control.hidden = true;
    for (const control of [main, secondary, settings]) {
      control.onclick = null;
      delete control.dataset.sessionAction;
      control.removeAttribute("aria-busy");
    }
    counts.hidden = manual.hidden = true;
  }
  function showError(error: unknown) {
    paint("harness.errorUnavailable");
    if (error instanceof Error) status.textContent = error.message;
    button(main, "common.retry", "refreshCw");
    main.onclick = () => void refresh();
  }
  function perform(control: HTMLButtonElement, signal: AbortSignal, change: () => Promise<void>) {
    control.onclick = async () => {
      if (saving || signal.aborted) return;
      saving = true;
      control.disabled = true;
      control.setAttribute("aria-busy", "true");
      try {
        await change();
      } catch (error) {
        if (!signal.aborted) showError(error);
        return;
      } finally {
        if (!signal.aborted) saving = false;
      }
      if (!signal.aborted) void refresh();
    };
  }
  function showCounts(contributions: number, recalls?: number) {
    counts.hidden = false;
    const format = new Intl.NumberFormat(document.documentElement.lang);
    contributed.textContent = format.format(contributions);
    recalled.parentElement!.hidden = recalls === undefined;
    recalled.textContent = recalls === undefined ? "" : format.format(recalls);
  }
  function renderLegacy(view: MemoryLegacySessionView, pathname: string, signal: AbortSignal) {
    const { automatic, canSave, entries } = view;
    const running = automatic.enabled && !automatic.paused;
    const label = automatic.paused
      ? "sessions.memoryInspectorPaused"
      : running
        ? automatic.organizerEnabled
          ? "sessions.memoryInspectorOn"
          : "sessions.memoryOrganizerOff"
        : "sessions.memoryInspectorOff";
    const description =
      running && !automatic.organizerEnabled
        ? "sessions.memoryOrganizerHint"
        : automatic.paused
          ? "sessions.memoryPausedHint"
          : "sessions.memoryNativeStartsNow";
    paint(label, description, running ? "active" : automatic.paused ? "paused" : undefined);
    if (automatic.enabled) showCounts(automatic.contributed);
    manual.hidden = false;
    localizeText(manual, "sessions.memoryManualCount", { count: entries.length }, t);
    if (entries.length) {
      button(canSave ? settings : main, "sessions.memoryView", "list", "memory-legacy-details");
    }
    if (!canSave) return;
    button(
      main,
      running ? "sessions.memoryPause" : automatic.paused ? "sessions.memoryResume" : "sessions.memoryEnableAction",
      running ? "pause" : "play",
    );
    button(secondary, "sessions.memoryManualSave", "listChecks", "memory-legacy-save");
    perform(main, signal, async () => {
      const next = await request<MemoryLegacySessionView>(
        pathname,
        "PATCH",
        { revision: automatic.revision, enabled: !running },
        requestSignal(signal),
      );
      if (!signal.aborted) renderLegacy(next, pathname, signal);
    });
  }
  function renderManaged(view: MemorySessionSummary, pathname: string, signal: AbortSignal) {
    const { policy, source, backfill } = view;
    const write = source.write ?? policy.write;
    const recall = source.recall ?? policy.recall;
    const pending = backfill.task?.state === "queued" || backfill.task?.state === "running";
    const [label, description, tone]: [MessageId, MessageId?, ("active" | "paused")?] = source.paused
      ? ["sessions.memoryInspectorPaused", "sessions.memoryPausedHint", "paused"]
      : !write && !recall
        ? ["sessions.memoryInspectorOff", "sessions.memoryInspectorOffHint"]
        : !write
          ? ["sessions.memoryInspectorRecallOnly", "sessions.memoryInspectorOffHint", "active"]
          : pending
            ? ["sessions.memoryInspectorPending", undefined, "active"]
            : view.contributed
              ? ["sessions.memoryInspectorOn", undefined, "active"]
              : [
                  "sessions.memoryInspectorEmpty",
                  backfill.availability === "boundaryUnavailable" ? "sessions.memoryBackfillBoundary" : undefined,
                  "active",
                ];
    const awaitingOrganizer = write && !source.paused && !policy.model?.enabled;
    paint(
      awaitingOrganizer ? "sessions.memoryOrganizerOff" : label,
      awaitingOrganizer ? "sessions.memoryOrganizerHint" : description,
      tone,
    );
    showCounts(view.contributed, view.recalled);
    if (!source.paused && !write) {
      button(main, "sessions.memoryEnableAction", "play");
      perform(main, signal, async () => {
        const next = await request<MemorySourcePolicy>(
          pathname + "/memory-policy",
          "PATCH",
          { revision: source.revision, write: true },
          requestSignal(signal),
        );
        if (!signal.aborted) renderManaged({ ...view, source: next }, pathname, signal);
      });
      if (view.contributed || view.recalled) button(secondary, "sessions.memoryView", "list", "memory-details");
    } else {
      const history = write && !source.paused && !pending && !view.contributed && backfill.availability === "available";
      button(
        main,
        history ? "sessions.memoryBackfill" : "sessions.memoryView",
        history ? "clock" : "list",
        history ? "memory-history" : "memory-details",
      );
      button(
        secondary,
        source.paused ? "sessions.memoryResume" : "sessions.memoryPause",
        source.paused ? "play" : "pause",
      );
      perform(secondary, signal, async () => {
        const next = await request<MemorySourcePolicy>(
          pathname + "/memory-policy",
          "PATCH",
          { revision: source.revision, paused: !source.paused },
          requestSignal(signal),
        );
        if (!signal.aborted) renderManaged({ ...view, source: next }, pathname, signal);
      });
    }
    button(settings, "sessions.memorySettings", "slidersHorizontal", "memory-settings");
    if (!source.paused && pending) polling = window.setTimeout(refresh, 2000);
  }
  const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  async function refresh() {
    if (!id || !cancellation || reading || saving || (scope !== "legacy" && scope !== "managed")) return;
    window.clearTimeout(polling);
    const { signal } = cancellation;
    reading = true;
    try {
      if (scope === "legacy") {
        const pathname = legacyMemoryPath + encodeURIComponent(id);
        const view = await request<MemoryLegacySessionView>(pathname, "GET", undefined, requestSignal(signal));
        if (!signal.aborted) renderLegacy(view, pathname, signal);
      } else {
        const pathname = conversationsPath + "/" + encodeURIComponent(id);
        const view = await request<MemorySessionSummary>(
          pathname + "/memory-summary",
          "GET",
          undefined,
          requestSignal(signal),
        );
        if (!signal.aborted && !saving) renderManaged(view, pathname, signal);
      }
    } catch (error) {
      if (!signal.aborted && !saving) showError(error);
    } finally {
      if (!signal.aborted) reading = false;
    }
  }

  function update(nextId: string | null, nextScope?: MemoryScope, nextRun = "") {
    if (id === nextId && scope === nextScope) {
      if (runStatus !== nextRun && (nextScope === "managed" || nextScope === "legacy")) void refresh();
      runStatus = nextRun;
      return;
    }
    id = nextId;
    scope = nextScope;
    runStatus = nextRun;
    cancellation?.abort();
    cancellation = undefined;
    window.clearTimeout(polling);
    reading = saving = false;
    host.hidden = !id;
    if (!id) return;
    if (scope === "private") {
      paint("sessions.memoryModePrivate", "sessions.memoryPrivateHint");
    } else if (scope === "unbound") {
      paint("sessions.memoryInspectorUnbound", "sessions.memoryInspectorUnboundHint");
      button(main, "projects.linkSessionToProject", "link", "project");
    } else {
      paint("common.pageLoading");
      cancellation = new AbortController();
      void refresh();
    }
  }

  return { update, refresh };
}
