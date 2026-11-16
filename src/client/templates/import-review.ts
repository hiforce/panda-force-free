import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, errorText } from "../i18n.js";

import { PluginApiError } from "../plugins/api.js";
import type { TemplateImportCandidate, ReviewedTemplateImport } from "./import-ports.js";

/** All import transports share selection, explicit approval and retry identity; the server remains the registry authority. */
export function createTemplateImportReview(
  t: Translate,
  host: HTMLElement,
  changed: () => void,
  onBusy: (busy: boolean) => void = () => {},
) {
  let epoch = 0,
    busy = false,
    candidate: TemplateImportCandidate | null = null,
    reviewed: ReviewedTemplateImport | null = null,
    operationId = "";
  host.classList.add("template-review-host");
  const get = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const selected = () =>
    [...host.querySelectorAll<HTMLInputElement>("[data-template-export]:checked")].map((input) => input.value);
  function notice(text: string, failed = false) {
    const target = get("[data-import-notice]");
    target.textContent = text;
    target.dataset.error = String(failed);
  }
  function controls() {
    host.setAttribute("aria-busy", String(busy));
    onBusy(busy);
    for (const input of host.querySelectorAll<HTMLInputElement>("input"))
      input.disabled = busy || input.hasAttribute("data-template-unsupported");
    for (const button of host.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = busy || (button.dataset.importAction === "review" && !selected().length);
  }
  function reset() {
    epoch++;
    busy = false;
    candidate = reviewed = null;
    operationId = "";
    setMessageHtml(
      host,
      `<div data-import-choices></div><button type="button" class="wb-button" data-import-action="review" disabled>${e(t("templates.reviewSelection"))}</button><p role="status" data-import-notice></p><div data-import-approval></div>`,
    );
    controls();
  }
  async function run(work: (generation: number) => Promise<void>) {
    if (busy) return;
    const generation = epoch;
    busy = true;
    controls();
    notice(t("plugins.working"));
    try {
      await work(generation);
    } catch (error) {
      if (generation === epoch)
        notice(
          errorText(error instanceof PluginApiError ? error.payload : null, t, "plugins.packageUnavailable"),
          true,
        );
    } finally {
      if (generation === epoch) {
        busy = false;
        controls();
      }
    }
  }
  function showApproval() {
    if (!reviewed) return;
    setMessageHtml(get("[data-import-approval]"), reviewed.approval(t));
    get<HTMLFormElement>("form").onsubmit = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const accepted = reviewed;
      if (!accepted) return;
      void run(async (generation) => {
        await accepted.install(operationId);
        changed();
        if (generation === epoch) {
          reviewed = null;
          get("[data-import-approval]").replaceChildren();
          notice(t("plugins.installed"));
        }
      });
    };
  }
  host.onchange = (event) => {
    if (event.target instanceof Element && event.target.matches("[data-template-export]")) {
      reviewed = null;
      get("[data-import-approval]").replaceChildren();
      controls();
    }
  };
  host.onclick = (event) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-import-action="review"]') : null;
    if (!button || button.disabled) return;
    const current = candidate;
    if (!current) return;
    void run(async (generation) => {
      const result = await current.review(selected());
      if (generation !== epoch) return;
      reviewed = result;
      operationId = crypto.randomUUID();
      showApproval();
      notice(t("plugins.readyForReview"));
    });
  };
  reset();
  return {
    reset,
    load(loader: () => Promise<TemplateImportCandidate>) {
      reset();
      return run(async (generation) => {
        const value = await loader();
        if (generation !== epoch) return;
        candidate = value;
        setMessageHtml(
          get("[data-import-choices]"),
          `<fieldset><legend>${e(t("templates.chooseExports"))}</legend>${value.choices.map((item) => `<label><input type="checkbox" data-template-export value="${e(item.key)}" ${item.disabled ? "disabled data-template-unsupported" : "checked"}><span>${e(item.label)}</span></label>`).join("")}</fieldset>`,
        );
        notice(t("templates.reviewSelection"));
      });
    },
  };
}
