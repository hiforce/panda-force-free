import { getBrowserI18n, setMessageHtml, errorText } from "../i18n.js";
import type { TemplatePreviewJob, TemplatePreviewView } from "../../shared/template-previews/contracts.js";
import type { ManagedTemplate } from "../../shared/templates/catalog.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";

import { PluginApiError } from "../plugins/api.js";
import { includedTemplatePreview } from "./builtins.js";
import { templatePreviewApi as api } from "./api.js";

/** Screenshot tabs and polling own no build or document state. A closed detail cannot receive stale images or errors. */
export function createTemplateScreenshotPanel(t: Translate, template: ManagedTemplate) {
  let host: HTMLElement | null = null,
    epoch = 0,
    job: TemplatePreviewJob | null = null,
    selected: TemplatePreviewView = "home";
  let timer: ReturnType<typeof setTimeout> | undefined,
    busy = false,
    pendingId = "",
    imageKey = "";
  const locale = () => getBrowserI18n().locale;
  function clear() {
    epoch++;
    clearTimeout(timer);
    host = null;
    job = null;
    selected = "home";
    busy = false;
    imageKey = "";
    pendingId = "";
  }
  function image(view: TemplatePreviewView) {
    if (job?.phase === "ready" && job.images[view])
      return "/api/template-previews/image?" + new URLSearchParams({ id: job.id, view });
    return includedTemplatePreview(template.key)?.images[view].path ?? null;
  }
  function render() {
    if (!host) return;
    const active = !!job && !["ready", "failed"].includes(job.phase),
      included = includedTemplatePreview(template.key);
    const status = host.querySelector<HTMLElement>("[data-preview-status]")!;
    status.textContent = job ? t(`previews.${job.phase}`) : t(included ? "previews.builtIn" : "previews.empty");
    const button = host.querySelector<HTMLButtonElement>("[data-preview-generate]")!;
    button.disabled = busy || active || !template.state.enabled;
    button.textContent = t(job ? "previews.retry" : "previews.generate");
    for (const tab of host.querySelectorAll<HTMLButtonElement>("[data-preview-view]")) {
      tab.disabled = !image(tab.dataset.previewView as TemplatePreviewView);
      tab.setAttribute("aria-pressed", String(selected === tab.dataset.previewView));
    }
    const path = image(selected),
      output = host.querySelector<HTMLElement>("[data-preview-image]")!,
      key = path ?? "";
    if (imageKey !== key) {
      imageKey = key;
      output.replaceChildren();
      output.dataset.view = selected;
      if (path) {
        const requestedEpoch = epoch,
          img = document.createElement("img");
        img.src = path;
        img.alt = t(`previews.${selected}`);
        img.decoding = "async";
        img.onerror = () => {
          if (host && epoch === requestedEpoch && imageKey === key)
            host.querySelector<HTMLElement>("[data-preview-error]")!.textContent = t("previews.previewUnavailable");
        };
        output.append(img);
      }
    }
    const issue = host.querySelector<HTMLElement>("[data-preview-error]")!;
    if (job?.failure) issue.textContent = t(`previews.${job.failure}`);
    const date = host.querySelector<HTMLElement>("[data-preview-date]")!;
    date.textContent =
      job?.phase === "ready"
        ? t("previews.updated", {
            date: new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(job.updatedAt),
          })
        : "";
  }
  function failed(error: unknown) {
    if (host)
      host.querySelector<HTMLElement>("[data-preview-error]")!.textContent = errorText(
        error instanceof PluginApiError ? error.payload : null,
        t,
        "previews.unavailable",
      );
  }
  function schedule() {
    clearTimeout(timer);
    if (host && job && !["ready", "failed"].includes(job.phase)) timer = setTimeout(() => void poll(), 1500);
  }
  async function poll() {
    if (!host || !job || busy) return;
    const generation = epoch;
    try {
      const result = await api.detail(job.id);
      if (generation === epoch) {
        job = result.job;
        render();
      }
    } catch (error) {
      if (generation === epoch) failed(error);
    } finally {
      if (generation === epoch) schedule();
    }
  }
  return {
    clear,
    async mount(target: HTMLElement) {
      clear();
      host = target;
      const generation = epoch;
      target.classList.add("template-screenshots");
      setMessageHtml(
        target,
        `<header><div><h3>${e(t("previews.title"))}</h3><p>${e(t("previews.hint"))}</p></div><button type="button" class="wb-button" data-preview-generate></button></header><nav class="styles-tabs">${(["home", "article", "mobile"] as const).map((view) => `<button type="button" data-preview-view="${view}">${e(t(`previews.${view}`))}</button>`).join("")}</nav><div class="template-screenshot-stage" data-preview-image></div><footer><span role="status" data-preview-status></span><small data-preview-date></small></footer><p role="status" data-preview-error></p>`,
      );
      target.onclick = (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button");
        if (!button || button.disabled || !host) return;
        if (button.dataset.previewView) {
          selected = button.dataset.previewView as TemplatePreviewView;
          render();
          return;
        }
        if (!button.hasAttribute("data-preview-generate") || busy) return;
        busy = true;
        render();
        host.querySelector("[data-preview-error]")!.textContent = "";
        const request = job
          ? api.retry(job.id)
          : api.start((pendingId ||= crypto.randomUUID()), template.key, locale());
        void request
          .then((result) => {
            if (generation === epoch) {
              job = result.job;
              pendingId = "";
            }
          })
          .catch((error) => {
            if (generation === epoch) failed(error);
          })
          .finally(() => {
            if (generation === epoch) {
              busy = false;
              render();
              schedule();
            }
          });
      };
      render();
      try {
        const result = await api.lookup(template.key, locale());
        if (generation === epoch) {
          job = result.job;
          render();
          schedule();
        }
      } catch (error) {
        if (generation === epoch) failed(error);
      }
    },
  };
}
