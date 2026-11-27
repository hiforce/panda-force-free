import { isProjectMemoryScope } from "../../shared/project-memory/contracts.js";
import { escapeHtml as escape } from "../../shared/html.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { MemoryLegacySessionView, MemoryManualConvention } from "../../shared/project-memory/contracts.js";
import type { harnessApi } from "../harness/api.js";
import { messageHtml, setMessageHtml } from "../i18n.js";

export function renderLegacyRecords(host: HTMLElement, entries: MemoryManualConvention[], t: Translate) {
  setMessageHtml(
    host,
    entries.length
      ? '<ul class="session-legacy-records">' +
          entries
            .map(
              (entry) =>
                `<li data-i18n-ignore><strong>${escape(entry.key)}</strong> ${isProjectMemoryScope(entry.scope) ? "" : `<small>${escape(entry.scope)}</small>`}<p>${escape(entry.value)}</p></li>`,
            )
            .join("") +
          "</ul>"
      : "<p>" + messageHtml("sessions.memoryNoContribution", {}, t) + "</p>",
  );
}

export function mountLegacyMemoryForm({
  host,
  status,
  url,
  signal,
  request,
  t,
  changed,
}: {
  host: HTMLElement;
  status: HTMLElement;
  url: string;
  signal: AbortSignal;
  request: ReturnType<typeof harnessApi>;
  t: Translate;
  changed?: () => void;
}) {
  setMessageHtml(
    host,
    `
    <form class="wb-form session-legacy-memory-form">
      <div data-legacy-candidates></div>
      <details data-legacy-manual open>
        <summary>${messageHtml("sessions.memoryManualWrite", {}, t)}</summary>
        <label class="wb-field"><span>${messageHtml("sessions.memoryManualKey", {}, t)}</span>
          <input class="wb-input" name="key" maxlength="80"></label>
        <label class="wb-field"><span>${messageHtml("sessions.memoryManualValue", {}, t)}</span>
          <input class="wb-input" name="value" maxlength="240"></label>
      </details>
      <p class="session-caption">${messageHtml("sessions.memoryManualOwner", {}, t)}</p>
      <button type="submit" class="wb-button primary" disabled>${messageHtml("sessions.memoryManualConfirm", {}, t)}</button>
    </form>`,
  );
  const form = host.querySelector<HTMLFormElement>("form")!;
  const list = form.querySelector<HTMLElement>("[data-legacy-candidates]")!;
  const manual = form.querySelector<HTMLDetailsElement>("[data-legacy-manual]")!;
  const key = form.querySelector<HTMLInputElement>('[name="key"]')!;
  const value = form.querySelector<HTMLInputElement>('[name="value"]')!;
  const save = form.querySelector<HTMLButtonElement>("button")!;
  let candidates: MemoryManualConvention[] = [];
  let writing = false;
  function updateSave() {
    save.disabled = writing || !(form.querySelector("input:checked") || (key.value.trim() && value.value.trim()));
  }
  form.oninput = updateSave;
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  void request<{ candidates: MemoryManualConvention[] }>(url + "?preview=true", "GET", undefined, requestSignal())
    .then((view) => {
      if (signal.aborted || !form.isConnected || !view.candidates.length) return;
      candidates = view.candidates;
      setMessageHtml(
        list,
        `
        <p>${messageHtml("sessions.memoryManualChoose", {}, t)}</p>
        ${candidates
          .map(
            (entry, index) =>
              `<label class="wb-choice session-legacy-choice"><input type="checkbox" name="candidate" value="${index}">
            <span data-i18n-ignore><strong>${escape(entry.key)}</strong> ${isProjectMemoryScope(entry.scope) ? "" : `<small>${escape(entry.scope)}</small>`}<span>${escape(entry.value)}</span></span>
          </label>`,
          )
          .join("")}`,
      );
      if (!key.value && !value.value && !manual.contains(document.activeElement)) manual.open = false;
      updateSave();
    })
    .catch(() => {
      if (!signal.aborted && form.isConnected) status.textContent = t("sessions.memoryManualPreviewUnavailable");
    });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled || signal.aborted) return;
    const picked = new FormData(form).getAll("candidate").map((index) => candidates[Number(index)]!);
    const [name, text] = [key.value.trim(), value.value.trim()];
    if (Boolean(name) !== Boolean(text)) {
      status.textContent = t("harness.errorInvalidInput");
      (name ? value : key).focus();
      return;
    }
    if (name && text) picked.push({ key: name, value: text, scope: "project" });
    if (picked.length > 8) {
      status.textContent = t("sessions.memoryManualBatch");
      return;
    }
    writing = true;
    updateSave();
    form.setAttribute("aria-busy", "true");
    status.textContent = t("common.pageLoading");
    try {
      const view = await request<MemoryLegacySessionView>(url, "POST", { entries: picked }, requestSignal());
      if (signal.aborted) return;
      renderLegacyRecords(host, view.entries, t);
      status.textContent = t("sessions.memoryManualSaved");
      status.focus({ preventScroll: true });
      changed?.();
    } catch (error) {
      if (!signal.aborted) status.textContent = error instanceof Error ? error.message : t("harness.errorUnavailable");
    } finally {
      writing = false;
      form.removeAttribute("aria-busy");
      updateSave();
    }
  };
}
