import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { searchRequest, SearchRequestError, type SearchResults, type SearchStatus } from "./api.js";
import { searchResultsHtml, searchStateLabel } from "./results.js";
import { searchModeField } from "./query-mode.js";

/** Each opening owns its requests, debounce and index-status polling; stale work cannot update a replacement modal. */
export function contentSearchPane(host: HTMLElement, t: Translate, projects: { id: string; name: string }[]) {
  let closed = false,
    read = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | null = null,
    cursor: string | null = null,
    pending = false;
  setMessageHtml(
    host,
    `<form class="content-search-form"><div class="content-search-scope"><label class="resource-field wb-field"><span>${e(t("search.scope"))}</span><select class="wb-select" data-search-project><option value="personal">${e(t("creative.personal"))}</option>${projects.map((p) => `<option value="${e(p.id)}">${e(p.name)}</option>`).join("")}</select></label>${searchModeField(t)}</div><label class="resource-field wb-field"><span>${e(t("search.query"))}</span><input type="search" data-content-query maxlength="300" autocomplete="off" placeholder="${e(t("search.queryHint"))}"></label><button class="wb-button" type="submit">${e(t("common.search"))}</button></form><p class="search-mode-hint" data-search-mode-hint hidden>${e(t("search.semanticHint"))}</p><p role="status" data-search-status>${e(t("search.searchHint"))}</p><div class="content-search-results" data-search-results></div><button class="wb-button" type="button" data-search-more hidden>${e(t("templates.loadMore"))}</button>`,
  );
  const get = <T extends HTMLElement>(q: string) => host.querySelector<T>(q)!,
    project = get<HTMLSelectElement>("[data-search-project]"),
    mode = get<HTMLSelectElement>("[data-search-mode]"),
    input = get<HTMLInputElement>("[data-content-query]"),
    submit = get<HTMLButtonElement>('[type="submit"]'),
    status = get("[data-search-status]"),
    results = get("[data-search-results]"),
    more = get<HTMLButtonElement>("[data-search-more]");
  const currentProject = new URL(location.href).searchParams.get("project");
  if (currentProject && [...project.options].some((o) => o.value === currentProject)) project.value = currentProject;
  function pollStatus(epoch: number, signal: AbortSignal, selectedProject: string, selectedMode: string, attempt = 0) {
    timer = setTimeout(async () => {
      try {
        const value = await searchRequest<SearchStatus>(
          "/status?" + new URLSearchParams({ project: selectedProject }),
          "GET",
          undefined,
          signal,
        );
        if (closed || epoch !== read) return;
        status.textContent = value.failure ? t("search.indexFailed") : searchStateLabel(value.state, t);
        if (!value.failure && value.ready) {
          if (selectedMode === "text") void run();
          else status.textContent = t("search.readyToSearch");
        } else if (["queued", "running"].includes(value.state) && attempt < 29)
          pollStatus(epoch, signal, selectedProject, selectedMode, attempt + 1);
      } catch {
        if (!closed && epoch === read && !signal.aborted) status.textContent = t("search.unavailable");
      }
    }, 1000);
  }
  async function run(append = false) {
    if (closed || (pending && mode.value !== "text")) return;
    clearTimeout(timer);
    controller?.abort();
    const local = (controller = new AbortController());
    const epoch = ++read,
      query = input.value.trim(),
      selectedProject = project.value,
      selectedMode = mode.value;
    more.hidden = true;
    if (!append) {
      cursor = null;
      results.replaceChildren();
    }
    if (!query) {
      pending = false;
      submit.disabled = false;
      status.textContent = t("search.searchHint");
      return;
    }
    status.textContent = t("search.searching");
    pending = true;
    submit.disabled = true;
    try {
      const value = await searchRequest<SearchResults>(
        "/query",
        "POST",
        { project: selectedProject, query, mode: selectedMode, ...(append && cursor ? { cursor } : {}) },
        local.signal,
      );
      if (closed || epoch !== read) return;
      const markup = searchResultsHtml(value, t);
      if (append) {
        const node = document.createElement("div");
        setMessageHtml(node, markup);
        results.append(...node.childNodes);
      } else setMessageHtml(results, markup);
      cursor = value.nextCursor;
      more.hidden = !cursor;
      status.textContent = value.failure ? t("search.indexFailed") : searchStateLabel(value.state, t);
      if (["queued", "running"].includes(value.state)) pollStatus(epoch, local.signal, selectedProject, selectedMode);
    } catch (error) {
      if (closed || epoch !== read || local.signal.aborted) return;
      status.textContent =
        error instanceof SearchRequestError && error.code === "indexChanged"
          ? t("search.indexChanged")
          : error instanceof SearchRequestError && error.code === "configuration"
            ? t("search.configuration")
            : t("search.unavailable");
    } finally {
      if (epoch === read) {
        pending = false;
        submit.disabled = false;
      }
    }
  }
  get<HTMLFormElement>("form").onsubmit = (event) => {
    event.preventDefault();
    void run();
  };
  const changed = () => {
    clearTimeout(timer);
    controller?.abort();
    read++;
    pending = false;
    submit.disabled = false;
    cursor = null;
    more.hidden = true;
    results.replaceChildren();
    get("[data-search-mode-hint]").hidden = mode.value === "text";
    status.textContent = t(mode.value === "text" ? "search.searchHint" : "search.submitQuery");
  };
  input.oninput = () => {
    changed();
    if (mode.value === "text") timer = setTimeout(() => void run(), 250);
  };
  project.onchange = mode.onchange = () => {
    changed();
    if (mode.value === "text" && input.value.trim()) void run();
  };
  more.onclick = () => void run(true);
  input.focus();
  return {
    close() {
      closed = true;
      read++;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
