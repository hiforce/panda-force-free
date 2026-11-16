import type { Translate } from "../../shared/i18n/messages.js";
import type { BuildRun } from "../../shared/builds/run.js";
import { terminalBuildRun } from "../../shared/builds/run.js";
import { PluginApiError } from "../plugins/api.js";
import { errorText, setMessageHtml } from "../i18n.js";

import { escapeHtml as e } from "../../shared/html.js";
import { phaseLabels } from "../build-phase-labels.js";
import { createStaticSitePreview } from "../static-site-preview.js";

export interface SampleBuildView extends BuildRun {
  theme: { id: string; version: string };
}
export interface SampleMonitorApi<Source, Job extends SampleBuildView> {
  lookup(source: Source): Promise<{ build: Job | null }>;
  start(id: string, source: Source): Promise<{ build: Job }>;
  detail(id: string): Promise<{ build: Job; logs: string }>;
  cancel(id: string): Promise<{ build: Job }>;
  pages(id: string): Promise<{ pages: string[] }>;
  preview(id: string, path: string): Promise<string>;
  download(id: string): Promise<Blob>;
}

/** Polls one frozen sample without replacing its controls, open logs or preview frame on every update. */
export function createBuildSampleMonitor<Source, Job extends SampleBuildView>(
  t: Translate,
  api: SampleMonitorApi<Source, Job>,
  options: {
    completed?: (job: Job) => void | Promise<void>;
    illustration?: (target: HTMLElement) => void;
    canStart?: () => boolean;
  } = {},
) {
  let epoch = 0,
    revision = 0,
    timer: ReturnType<typeof setTimeout> | null = null;
  let host: HTMLElement | null = null,
    source: Source | null = null,
    job: Job | null = null;
  let busy = false,
    error = "",
    pendingId = "",
    notified = "",
    previewId = "";
  const preview = createStaticSitePreview(t, {
    ...api,
    errorPayload: (value) => (value instanceof PluginApiError ? value.payload : null),
  });
  const get = <T extends HTMLElement>(selector: string) => host!.querySelector<T>(selector)!;
  const failure = (value: unknown) =>
    errorText(value instanceof PluginApiError ? value.payload : null, t, "builds.unavailable");
  function resetPreview() {
    preview.clear();
    previewId = "";
    notified = "";
    if (host) {
      get("[data-sample-preview]").replaceChildren();
      options.illustration?.(get("[data-sample-preview]"));
    }
  }
  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function clear() {
    epoch++;
    revision++;
    stopTimer();
    preview.clear();
    host?.replaceChildren();
    host = null;
    source = null;
    job = null;
    busy = false;
    pendingId = "";
    error = "";
    notified = "";
    previewId = "";
  }
  function render() {
    if (!host) return;
    host.setAttribute("aria-busy", String(busy));
    const active = job && !terminalBuildRun(job);
    get("[data-sample-status]").textContent = busy
      ? t("plugins.working")
      : job
        ? t(phaseLabels[job.phase])
        : t("plugins.sampleReady");
    get("[data-sample-status]").dataset.phase = job?.phase || "idle";
    const start = get<HTMLButtonElement>('[data-sample-action="start"]');
    start.textContent = t(
      pendingId ? "plugins.sampleRetryRequest" : job ? "plugins.sampleRebuild" : "plugins.sampleBuild",
    );
    start.disabled = busy || Boolean(active) || options.canStart?.() === false;
    const cancel = get<HTMLButtonElement>('[data-sample-action="cancel"]');
    cancel.hidden = !active;
    cancel.disabled = busy || job?.phase === "cancelling";
    const download = get<HTMLButtonElement>('[data-sample-action="download"]');
    download.hidden = !job?.artifactAvailable;
    download.disabled = busy;
    const issue = error || (job?.error ? errorText({ messageId: "builds." + job.error }, t, "builds.unavailable") : "");
    get("[data-sample-error]").textContent = issue;
    get("[data-sample-identity]").textContent = job ? `${job.engine} · ${job.theme.id} @ ${job.theme.version}` : "";
    get("[data-sample-logs]").hidden = !job;
    get("[data-sample-static]").hidden = !job?.artifactAvailable;
  }
  function schedule() {
    stopTimer();
    if (
      host &&
      job &&
      (!terminalBuildRun(job) || (job.phase === "completed" && job.artifactAvailable && notified !== job.id))
    )
      timer = setTimeout(() => void poll(), 2000);
  }
  async function collected(generation: number) {
    if (!host || job?.phase !== "completed" || !job.artifactAvailable) return;
    const saved = job;
    if (previewId !== saved.id) {
      previewId = saved.id;
      await preview.mount(get("[data-sample-preview]"), saved.id);
    }
    if (generation !== epoch || job?.id !== saved.id || notified === saved.id) return;
    await options.completed?.(saved);
    if (generation === epoch && job?.id === saved.id) notified = saved.id;
  }
  async function poll() {
    if (!host || !job || busy) return;
    const generation = epoch,
      request = ++revision,
      id = job.id;
    try {
      const result = await api.detail(id);
      if (generation !== epoch || request !== revision) return;
      job = result.build;
      error = "";
      const logs = get("[data-sample-log-text]");
      if (logs.textContent !== result.logs) logs.textContent = result.logs;
      render();
      await collected(generation);
    } catch (value) {
      if (generation !== epoch || request !== revision) return;
      error = failure(value);
      if (value instanceof PluginApiError && value.status === 404) {
        job = null;
        resetPreview();
      }
      render();
    } finally {
      if (generation === epoch && request === revision) schedule();
    }
  }
  async function action(name: string) {
    if (!host || !source || busy || !["start", "cancel", "download"].includes(name)) return;
    if ((name === "download" && !job?.artifactAvailable) || (name === "cancel" && !job)) return;
    const generation = epoch,
      request = ++revision;
    stopTimer();
    busy = true;
    error = "";
    render();
    try {
      if (name === "download" && job?.artifactAvailable) {
        const id = job.id,
          blob = await api.download(id);
        if (generation !== epoch || request !== revision) return;
        const url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = `site-sample-${id}.zip`;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
      const result =
        name === "cancel" && job
          ? await api.cancel(job.id)
          : await api.start((pendingId ||= crypto.randomUUID()), source);
      if (generation !== epoch || request !== revision) return;
      if (job?.id !== result.build.id) resetPreview();
      job = result.build;
      pendingId = "";
      render();
      await collected(generation);
    } catch (value) {
      if (generation === epoch && request === revision) error = failure(value);
    } finally {
      if (generation === epoch && request === revision) {
        busy = false;
        render();
        schedule();
      }
    }
  }
  async function mount(target: HTMLElement, value: Source) {
    clear();
    host = target;
    source = structuredClone(value);
    busy = true;
    const generation = epoch,
      request = ++revision;
    target.classList.add("site-sample-monitor");
    setMessageHtml(
      target,
      `<header><strong>${e(t("plugins.sampleTitle"))}</strong><span role="status" data-sample-status></span></header><p data-sample-identity></p><div class="site-sample-actions"><button type="button" class="wb-button" data-sample-action="start"></button><button type="button" class="wb-button" data-sample-action="cancel">${e(t("builds.cancel"))}</button><button type="button" class="wb-button" data-sample-action="download" hidden>${e(t("builds.download"))}</button></div><p role="status" class="site-sample-error" data-sample-error></p><details data-sample-logs hidden><summary>${e(t("builds.logs"))}</summary><pre data-sample-log-text data-i18n-ignore></pre></details><p data-sample-static hidden>${e(t("builds.previewNotice"))}</p><div class="site-sample-preview" data-sample-preview></div>`,
    );
    options.illustration?.(get("[data-sample-preview]"));
    target.onclick = (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-sample-action]") : null;
      if (button && !button.disabled) void action(button.dataset.sampleAction!);
    };
    render();
    try {
      const result = await api.lookup(value);
      if (generation !== epoch || request !== revision) return;
      job = result.build;
      render();
      await collected(generation);
    } catch (value) {
      if (generation === epoch && request === revision) error = failure(value);
    } finally {
      if (generation === epoch && request === revision) {
        busy = false;
        render();
        schedule();
      }
    }
  }
  return { mount, clear };
}
