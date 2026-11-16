import type { Translate } from "../../shared/i18n/messages.js";
import type { SourceLimits } from "../../shared/packages/sources/contracts.js";
import type { SourceStageView } from "../../shared/packages/stages/contracts.js";
import { setMessageHtml, errorText } from "../i18n.js";

import { sourceImportApi, sourceFileDigest, SourceApiError, inspectTemplateSource } from "./api.js";
import { sourceImportFrame, sourceTaskFrame, sourceInProgress } from "./views.js";
import { createSourceInspection } from "./inspection.js";

/** The dialog projects server revisions; polling never replaces active inputs or a newer task receipt. */
export function createSourceImport(t: Translate, changed: () => void = () => {}) {
  const dialog = document.createElement("dialog"),
    api = sourceImportApi("templates");
  dialog.id = "sourceTemplateImport";
  dialog.className = "package-dialog source-import-dialog";
  document.body.append(dialog);
  let epoch = 0,
    inspectionEpoch = 0,
    inspectedId: string | null = null,
    opened = false,
    busy = false,
    reading = false,
    limits: SourceLimits | null = null,
    resumeId: string | null = null,
    autoInspectId: string | null = null,
    previous: HTMLElement | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    abort: AbortController | null = null,
    attempt: { key: string; id: string } | null = null,
    inspection: ReturnType<typeof createSourceInspection> | null = null;
  const tasks = new Map<string, SourceStageView>(),
    pending = new Set<string>();
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  function notice(value: string, error = false) {
    const node = get("[data-source-notice]");
    node.textContent = value;
    node.dataset.error = String(error);
  }
  function failure(error: unknown) {
    notice(errorText(error instanceof SourceApiError ? error.payload : null, t, "sources.stageUnavailable"), true);
  }
  function controls() {
    get<HTMLButtonElement>("[data-source-submit]").disabled = busy || !limits;
    get<HTMLFormElement>("[data-source-form]").setAttribute("aria-busy", String(busy));
  }
  function render(task: SourceStageView) {
    let node = get("[data-source-tasks]").querySelector<HTMLElement>(`[data-source-task="${task.id}"]`);
    if (task.state === "removed") {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("article");
      node.dataset.sourceTask = task.id;
      node.className = "source-task";
      setMessageHtml(node, sourceTaskFrame(t));
      get("[data-source-tasks]").prepend(node);
    }
    node.querySelector("[data-source-name]")!.textContent =
      task.request.source.kind === "zip-upload" ? task.request.source.name : task.request.source.repository;
    const status = node.querySelector<HTMLElement>("[data-source-status]")!;
    status.textContent = t(`sources.${task.state}`);
    status.dataset.active = String(sourceInProgress(task));
    node.querySelector("[data-source-failure]")!.textContent = task.failure ? t(`sources.${task.failure}`) : "";
    node.querySelector("[data-source-hint]")!.textContent =
      task.state === "reserved" && task.request.source.kind === "zip-upload" ? t("sources.uploadRequired") : "";
    for (const button of node.querySelectorAll<HTMLButtonElement>("[data-source-action]")) {
      const action = button.dataset.sourceAction;
      button.hidden =
        action === "resume"
          ? task.state !== "reserved" || task.request.source.kind !== "zip-upload"
          : action === "inspect"
            ? task.state !== "ready"
            : action === "cancel"
              ? !["reserved", "uploading", "uploaded", "acquiring", "writing"].includes(task.state)
              : task.state === "removing";
      button.disabled = pending.has(task.id);
    }
  }
  function merge(values: readonly SourceStageView[]) {
    for (const task of [...values].reverse()) {
      const prior = tasks.get(task.id);
      if (prior && prior.revision >= task.revision) continue;
      tasks.set(task.id, task);
      render(task);
      if (autoInspectId === task.id && task.state === "ready") {
        autoInspectId = null;
        void command("inspect", task);
      }
    }
    get("[data-source-empty]").hidden = [...tasks.values()].some((task) => task.state !== "removed");
  }
  async function refresh() {
    if (!opened || reading) return;
    const generation = epoch;
    reading = true;
    clearTimeout(timer);
    try {
      const values = await api.list(abort!.signal);
      if (generation !== epoch) return;
      merge(values);
    } catch (error) {
      if (generation === epoch) failure(error);
    } finally {
      if (generation === epoch) {
        reading = false;
        if ([...tasks.values()].some(sourceInProgress)) timer = setTimeout(() => void refresh(), 1500);
      }
    }
  }
  async function submit(selectedFile?: File) {
    if (busy || !limits) return;
    const generation = epoch,
      file = selectedFile ?? get<HTMLInputElement>("[data-source-file]").files?.[0],
      kind = get<HTMLSelectElement>("[data-source-kind]").value,
      resumed = resumeId;
    busy = true;
    controls();
    notice(t("sources.working"));
    try {
      let task: SourceStageView;
      if (kind === "zip-upload") {
        if (!file) throw new SourceApiError(400, { messageId: "sources.chooseSource" });
        if (!resumed && file.size > limits.archiveBytes)
          throw new SourceApiError(413, {
            messageId: "sources.fileTooLarge",
            messageArgs: { bytes: limits.archiveBytes },
          });
        const sha256 = await sourceFileDigest(file);
        if (generation !== epoch) return;
        if (resumed) {
          task = await api.task(resumed);
          if (
            task.request.source.kind !== "zip-upload" ||
            task.request.source.bytes !== file.size ||
            task.request.source.sha256 !== sha256
          )
            throw new SourceApiError(409, { messageId: "sources.sourceChanged" });
        } else {
          const input = { source: { kind: "zip-upload", name: file.name, bytes: file.size, sha256 } },
            key = JSON.stringify(input);
          if (!attempt || attempt.key !== key) attempt = { key, id: crypto.randomUUID() };
          task = await api.submit(attempt.id, input);
        }
        if (selectedFile && generation === epoch) autoInspectId = task.id;
        if (generation === epoch) merge([task]);
        // An accepted upload finishes even if the dialog closes; its receipt is available on reopening.
        if (task.state === "reserved") task = await api.upload(task, file);
      } else {
        const input = {
            source: {
              kind: "github",
              repository: get<HTMLInputElement>("[data-source-repository]").value.trim(),
              ref: get<HTMLInputElement>("[data-source-ref]").value.trim() || null,
              root: get<HTMLInputElement>("[data-source-root]").value.trim(),
            },
          },
          key = JSON.stringify(input);
        if (!attempt || attempt.key !== key) attempt = { key, id: crypto.randomUUID() };
        task = await api.submit(attempt.id, input);
      }
      if (generation !== epoch) return;
      merge([task]);
      resumeId = null;
      notice("");
      void refresh();
    } catch (error) {
      if (generation === epoch) {
        failure(error);
        void refresh();
      }
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  async function command(action: string, task: SourceStageView) {
    if (pending.has(task.id)) return;
    const generation = epoch;
    pending.add(task.id);
    render(task);
    try {
      if (action === "inspect") {
        const inspectionGeneration = ++inspectionEpoch;
        inspectedId = task.id;
        inspection?.loading();
        const value = await inspectTemplateSource(task.id);
        if (generation === epoch && inspectionGeneration === inspectionEpoch) inspection?.show(value, task.id);
      } else {
        const value = action === "cancel" ? await api.cancel(task) : await api.remove(task);
        if (generation === epoch) {
          merge([value]);
          if (action === "remove" && inspectedId === task.id) {
            inspectionEpoch++;
            inspectedId = null;
            inspection?.clear();
          }
        }
      }
    } catch (error) {
      if (generation === epoch && (action !== "inspect" || inspectedId === task.id)) failure(error);
    } finally {
      if (generation === epoch) {
        pending.delete(task.id);
        const current = tasks.get(task.id);
        if (current) render(current);
        void refresh();
      }
    }
  }
  function close() {
    epoch++;
    inspectionEpoch++;
    inspectedId = null;
    opened = false;
    busy = reading = false;
    clearTimeout(timer);
    abort?.abort();
    abort = null;
    tasks.clear();
    pending.clear();
    limits = null;
    attempt = null;
    resumeId = null;
    autoInspectId = null;
    inspection?.clear();
    inspection = null;
    if (dialog.open) dialog.close();
    previous?.focus();
    previous = null;
  }
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };
  dialog.onsubmit = (event) => {
    if (event.target instanceof Element && event.target.matches("[data-source-form]")) {
      event.preventDefault();
      void submit();
    }
  };
  dialog.onchange = (event) => {
    if (event.target instanceof Element && event.target.matches("[data-source-kind]")) {
      const zip = get<HTMLSelectElement>("[data-source-kind]").value === "zip-upload";
      get("[data-source-zip]").hidden = !zip;
      get("[data-source-github]").hidden = zip;
      resumeId = null;
    }
  };
  dialog.onclick = (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-source-action]") : null;
    if (!button || button.disabled) return;
    const action = button.dataset.sourceAction!;
    if (action === "close") return close();
    if (action === "refresh") return void refresh();
    const task = tasks.get(button.closest<HTMLElement>("[data-source-task]")?.dataset.sourceTask ?? "");
    if (!task) return;
    if (action === "resume") {
      resumeId = task.id;
      get<HTMLSelectElement>("[data-source-kind]").value = "zip-upload";
      get("[data-source-zip]").hidden = false;
      get("[data-source-github]").hidden = true;
      notice(t("sources.uploadRequired"));
      get<HTMLInputElement>("[data-source-file]").click();
    } else void command(action, task);
  };
  return {
    close,
    async open(selectedFile?: File) {
      close();
      opened = true;
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      abort = new AbortController();
      const generation = epoch;
      setMessageHtml(dialog, sourceImportFrame(t));
      dialog.showModal();
      inspection = createSourceInspection(t, get("[data-source-inspection]"), changed);
      void refresh();
      try {
        const policy = await api.policy(abort.signal);
        if (generation === epoch) {
          limits = policy.limits;
          controls();
          if (selectedFile) await submit(selectedFile);
        }
      } catch (error) {
        if (generation === epoch) failure(error);
      }
    },
  };
}
