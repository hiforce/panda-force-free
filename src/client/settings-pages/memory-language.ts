import type { MemoryPreferences, ProjectMemoryLanguage } from "../../shared/project-memory/contracts.js";
import {
  memoryLanguage,
  memoryLanguageChoices,
  memoryLanguageLabel,
  memoryPreferencesPath,
} from "../../shared/project-memory/language.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { harnessApi } from "../harness/api.js";
import { messageHtml, setMessageHtml } from "../i18n.js";

type Preferences = MemoryPreferences | ProjectMemoryLanguage;
const inherit = "inherit";

export function mountMemoryLanguage(host: HTMLElement, t: Translate, signal: AbortSignal, project?: string) {
  const api = harnessApi(t);
  const m = (id: MessageId) => messageHtml(id, {}, t);
  const path = project ? "/api/projects/" + encodeURIComponent(project) + "/memory-language" : memoryPreferencesPath;
  const hint = project ? "memoryProjectLanguageHint" : "memoryLanguageHint";
  setMessageHtml(
    host,
    `<form class="wb-form">
    <label class="wb-field"><span>${m(project ? "projects.memoryProjectLanguage" : "projects.memoryLanguage")}</span>
      <select class="wb-select" data-memory-language aria-describedby="${hint}" disabled></select></label>
    <details data-memory-language-search-options><summary>${m("projects.memoryLanguageSearch")}</summary>
      <label class="wb-field"><span class="sr-only">${m("projects.memoryLanguageSearch")}</span>
      <input class="wb-input" type="search" data-memory-language-search maxlength="40" autocomplete="off" disabled></label></details>
    <p class="wb-help" id="${hint}">${m(project ? "projects.memoryProjectLanguageHint" : "projects.memoryLanguageHint")}</p>
    <p role="status" data-memory-language-status hidden></p>
    <div class="resource-actions">
      <button type="button" class="wb-button" data-memory-language-retry hidden>${m("common.retry")}</button>
      <button type="submit" class="wb-button" data-memory-language-save disabled>${m("projects.memoryLanguageSave")}</button>
    </div></form>`,
  );
  const form = host.querySelector("form")!;
  const filter = form.querySelector<HTMLInputElement>("[data-memory-language-search]")!;
  const picker = form.querySelector<HTMLSelectElement>("[data-memory-language]")!;
  const status = form.querySelector<HTMLElement>("[data-memory-language-status]")!;
  const retry = form.querySelector<HTMLButtonElement>("[data-memory-language-retry]")!;
  const save = form.querySelector<HTMLButtonElement>("[data-memory-language-save]")!;
  const locale = document.documentElement.lang || "en";
  const names = new Intl.DisplayNames(locale, { type: "language" });
  const order = new Intl.Collator(locale);
  let preferences: Preferences | undefined;
  let draft = "";
  let busy = false;

  function notice(text: string) {
    status.textContent = text;
    status.hidden = !text;
  }

  function controls() {
    filter.disabled = picker.disabled = !preferences || busy;
    save.disabled = !preferences || busy || !picker.value || picker.value === (preferences.language ?? inherit);
  }

  function options() {
    const query = filter.value.trim().toLocaleLowerCase();
    const match = memoryLanguage(query);
    const codes = new Set([...memoryLanguageChoices, draft, match ?? ""].filter((tag) => tag && tag !== inherit));
    const entries = [...codes]
      .map((tag) => ({ tag, label: names.of(tag) ?? tag }))
      .filter(
        ({ tag, label }) =>
          !query || [tag, label, memoryLanguageLabel(tag)].some((value) => value.toLocaleLowerCase().includes(query)),
      )
      .sort((a, b) => order.compare(a.label, b.label) || a.tag.localeCompare(b.tag));
    const choices = [new Option(t("projects.memoryLanguageChoose"), "")];
    if (preferences && "inheritedLanguage" in preferences)
      choices.push(
        new Option(
          t("projects.memoryLanguageInherit", {
            language: names.of(preferences.inheritedLanguage) ?? preferences.inheritedLanguage,
          }),
          inherit,
        ),
      );
    choices.push(...entries.map(({ tag, label }) => new Option(`${label} · ${tag}`, tag)));
    picker.replaceChildren(...choices);
    picker.value = draft;
    controls();
  }

  async function load() {
    retry.hidden = true;
    notice(t("common.pageLoading"));
    try {
      const next = await api<Preferences>(path, "GET", undefined, signal);
      if (signal.aborted) return;
      preferences = next;
      draft ||= next.language ?? inherit;
      options();
      notice("");
    } catch (error) {
      if (signal.aborted) return;
      notice(error instanceof Error ? error.message : t("harness.errorUnavailable"));
      retry.hidden = false;
    }
  }
  retry.onclick = () => void load();
  filter.oninput = options;
  picker.onchange = () => {
    draft = picker.value;
    controls();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!preferences || save.disabled) return;
    busy = true;
    controls();
    notice(t("common.pageLoading"));
    try {
      preferences = await api<Preferences>(
        path,
        "PATCH",
        { revision: preferences.revision, language: draft === inherit ? null : draft },
        signal,
      );
      if (signal.aborted) return;
      draft = preferences.language ?? inherit;
      filter.value = "";
      options();
      notice(t("projects.memorySaved"));
    } catch (error) {
      if (signal.aborted) return;
      notice(error instanceof Error ? error.message : t("harness.errorUnavailable"));
      if (error && typeof error === "object" && "code" in error && error.code === "conflict") {
        preferences = undefined;
        retry.hidden = false;
      }
    } finally {
      if (!signal.aborted) {
        busy = false;
        controls();
      }
    }
  };
  void load();
}
