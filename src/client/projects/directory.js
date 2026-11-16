import { escapeHtml as escape } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { findElement } from "../dom.js";
import { getBrowserI18n, messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";
import { storage, STORAGE_KEYS } from "../storage.js";
import { projectDirectoryPage } from "./directory-model.js";

/** Owns project browsing preferences and compact card/list presentation.
 * @param {{ root: HTMLElement; t: ReturnType<typeof getBrowserI18n>["t"]; catalog: ReturnType<typeof import("../project-catalog.js").createProjectCatalog>; isProjectPinned: (id: string) => boolean; identityKey: string }} options
 */
export function createProjectDirectory({ root, t, catalog, isProjectPinned, identityKey }) {
  let identity,
    layout = "list",
    sort = "updated",
    query = "",
    filter = "all",
    page = 1,
    position = 0;
  const pinned = (id) => isProjectPinned("project:" + id);
  const message = (key, args = {}) => messageHtml(key, args, t);
  const attributes = (key, args = {}) =>
    messageAttributes("aria-label", key, args, t) + " " + messageAttributes("title", key, args, t);
  function synchronizeIdentity() {
    const next = identityKey;
    if (next === identity) return;
    identity = next;
    const saved = storage.getJson(STORAGE_KEYS.projectDirectoryFor(identity), {});
    layout = saved?.layout === "cards" ? "cards" : "list";
    sort = ["updated", "name", "sessions"].includes(saved?.sort) ? saved.sort : "updated";
    query = "";
    filter = "all";
    page = 1;
    position = 0;
  }
  function selection() {
    return projectDirectoryPage(catalog.projects(), {
      query,
      filter,
      sort,
      page,
      pinned,
      compare: getBrowserI18n().format.compare,
    });
  }
  function iconAction(icon, action, label, project, extra = "") {
    return `<button type="button" class="wb-button project-directory-icon" data-wb="${action}" data-project-id="${escape(project.id)}" ${attributes(label, action === "pin" ? { name: project.name } : undefined)} ${extra}>${codexIcon(icon)}</button>`;
  }
  function projectItem(project) {
    const isPinned = pinned(project.id);
    const path = "/project?id=" + encodeURIComponent(project.id);
    const date = project.updatedAt ? new Date(project.updatedAt) : null;
    return `<li class="project-directory-item" data-project-item="${escape(project.id)}">
      <a class="wb-project-main project-directory-main" href="${path}">
        <span class="project-directory-symbol" aria-hidden="true">${codexIcon("folderOpen")}</span>
        <span class="project-directory-copy"><strong data-i18n-ignore>${escape(project.name)}</strong>
          <span class="project-directory-subline"><code data-i18n-ignore>${escape(project.code)}</code>${project.description ? `<span class="project-directory-description" data-i18n-ignore>${escape(project.description)}</span>` : ""}</span>
        </span>
      </a>
      <a class="project-directory-sessions" href="${path}&tab=sessions">${codexIcon("messageSquare")}${message("sessions.count", { count: project.threads.length })}</a>
      <span class="project-directory-updated">${date && Number.isFinite(date.getTime()) ? `<time datetime="${date.toISOString()}" data-i18n-ignore title="${escape(getBrowserI18n().format.dateTime(date, { dateStyle: "medium", timeStyle: "short" }))}">${escape(getBrowserI18n().format.dateTime(date, { month: "short", day: "numeric", ...(layout === "list" ? { year: "numeric" } : {}) }))}</time>` : '<span aria-hidden="true">—</span>'}</span>
      <div class="project-directory-actions">
        <a class="wb-button project-directory-icon" href="/documents?project=${encodeURIComponent(project.id)}" ${attributes("documents.open")}>${codexIcon("file")}</a>
        ${iconAction("plus", "project-new", "common.newSession", project)}
        ${iconAction("pin", "pin", isPinned ? "common.unpinProjectName" : "common.pinProjectName", project, `id="project-pin-${escape(project.id)}" aria-pressed="${isPinned}"`)}
      </div>
    </li>`;
  }
  function renderResults() {
    const results = findElement("#wbProjectResults", root);
    if (!results) return;
    const selected = selection();
    page = selected.page;
    const hasCatalog = selected.total > 0;
    setMessageHtml(
      results,
      !catalog.ready
        ? `<div class="project-directory-empty" role="status">${message("common.loadingProjects2")}</div>`
        : selected.items.length
          ? `<div class="project-directory-columns" aria-hidden="true"><span>${message("common.project")}</span><span>${message("common.sessions")}</span><span>${message("projects.updated")}</span><span>${message("projects.quickActions")}</span></div><ul class="project-directory-collection" data-layout="${layout}">${selected.items.map(projectItem).join("")}</ul>`
          : `<div class="project-directory-empty">${codexIcon(hasCatalog ? "search" : "folderOpen")}<h2>${message(hasCatalog ? "workbench.noMatchingProjects" : "projects.emptyTitle")}</h2><p>${message(hasCatalog ? "projects.noMatchesHelp" : "projects.emptyHelp")}</p><button type="button" class="wb-button" ${hasCatalog ? 'data-project-action="reset"' : 'data-wb="create-project"'}>${message(hasCatalog ? "projects.clearFilters" : "common.createProject")}</button></div>`,
    );
    results.dataset.layout = layout;
    const topPages = findElement("#projectDirectoryTopPages", root);
    if (topPages)
      setMessageHtml(
        topPages,
        selected.pages > 1
          ? `<button type="button" class="wb-button project-directory-icon" data-project-action="previous" ${attributes("projects.previousPage")} ${page === 1 ? "disabled" : ""}>${codexIcon("chevronLeft")}</button><span>${message("projects.pagePosition", { page, pages: selected.pages })}</span><button type="button" class="wb-button project-directory-icon" data-project-action="next" ${attributes("projects.nextPage")} ${page === selected.pages ? "disabled" : ""}>${codexIcon("chevronRight")}</button>`
          : "",
      );

    const footer = findElement("#projectDirectoryPagination", root);
    if (footer)
      setMessageHtml(
        footer,
        catalog.ready && selected.matches
          ? `<span role="status">${message("projects.resultRange", { start: selected.start, end: selected.end, total: selected.matches })}</span><div class="project-directory-pages"><button type="button" class="wb-button project-directory-icon" data-project-action="previous" ${attributes("projects.previousPage")} ${page === 1 ? "disabled" : ""}>${codexIcon("chevronLeft")}</button><span>${message("projects.pagePosition", { page, pages: selected.pages })}</span><button type="button" class="wb-button project-directory-icon" data-project-action="next" ${attributes("projects.nextPage")} ${page === selected.pages ? "disabled" : ""}>${codexIcon("chevronRight")}</button></div>`
          : "",
      );
  }
  function render() {
    synchronizeIdentity();
    const viewport = root.closest(".workbench-view");
    const focused = root.contains(document.activeElement) ? document.activeElement?.id : "";
    const selected = selection();
    setMessageHtml(
      root,
      `<section class="project-directory">
      <header class="wb-page-heading project-directory-heading"><div><div class="project-directory-title"><h1>${message("common.projects")}</h1>${catalog.ready ? `<span class="project-directory-count" data-i18n-ignore>${escape(getBrowserI18n().format.number(selected.total))}</span>` : ""}</div><p>${message("projects.directoryDescription")}</p></div><button type="button" class="wb-button primary" data-wb="create-project">${codexIcon("plus")}${message("common.createProject")}</button></header>
      <div class="project-directory-toolbar wb-form">
        <label class="wb-field project-directory-search"><span class="project-directory-caption">${message("workbench.searchProjects")}</span><span class="project-directory-search-control wb-control-with-icon">${codexIcon("search")}<input id="wbProjectSearch" type="search" ${attributes("workbench.searchProjects")} ${messageAttributes("placeholder", "projects.searchPlaceholder", undefined, t)} value="${escape(query)}"></span></label>
        <div class="project-directory-filters" role="group" ${attributes("projects.filterProjects")}>${[
          ["all", "projects.allProjects", selected.total],
          ["pinned", "projects.pinnedProjects", selected.pinnedCount],
        ]
          .map(
            ([value, label, count]) =>
              `<button type="button" class="wb-button" id="project-filter-${value}" data-project-action="filter" data-value="${value}" aria-pressed="${filter === value}">${value === "pinned" ? codexIcon("pin") : ""}${message(label)}<span data-i18n-ignore>${escape(getBrowserI18n().format.number(count))}</span></button>`,
          )
          .join("")}</div>
        <label class="wb-field project-directory-sort"><span class="project-directory-caption">${message("projects.sortProjects")}</span><select id="projectDirectorySort" class="wb-select" ${attributes("projects.sortProjects")}>${[
          ["updated", "projects.sortUpdated"],
          ["name", "projects.sortName"],
          ["sessions", "projects.sortSessions"],
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${sort === value ? "selected" : ""} data-pf-message="${label}">${escape(t(/** @type {import("../../shared/i18n/messages.js").MessageId} */ (label)))}</option>`,
          )
          .join("")}</select></label>
        <div class="project-directory-layout" role="group" ${attributes("projects.projectView")}>${[
          ["list", "list", "projects.listView"],
          ["cards", "layout", "projects.cardView"],
        ]
          .map(
            ([value, icon, label]) =>
              `<button type="button" class="wb-button" id="project-layout-${value}" data-project-action="layout" data-value="${value}" aria-pressed="${layout === value}" ${attributes(label)}>${codexIcon(icon)}${message(label)}</button>`,
          )
          .join("")}</div>
        <div class="project-directory-top-pages" id="projectDirectoryTopPages"></div>
      </div>
      <div id="wbProjectResults" aria-busy="${!catalog.ready}"></div><footer id="projectDirectoryPagination" class="project-directory-pagination"></footer>
    </section>`,
    );
    renderResults();
    if (viewport) viewport.scrollTop = position;
    if (focused) findElement("#" + CSS.escape(focused), root)?.focus({ preventScroll: true });
  }
  root.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.id !== "wbProjectSearch") return;
    query = event.target.value;
    page = 1;
    renderResults();
  });
  root.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement) || event.target.id !== "projectDirectorySort") return;
    sort = event.target.value;
    page = 1;
    storage.setJson(STORAGE_KEYS.projectDirectoryFor(identity), { layout, sort });
    render();
  });
  root.addEventListener("click", (event) => {
    const control = event.target instanceof Element ? event.target.closest("[data-project-action]") : null;
    if (!control || !root.contains(control)) return;
    const action = control.getAttribute("data-project-action");
    if (action === "layout") layout = control.getAttribute("data-value") === "cards" ? "cards" : "list";
    else if (action === "filter") {
      filter = control.getAttribute("data-value") === "pinned" ? "pinned" : "all";
      page = 1;
      position = 0;
    } else if (action === "reset") {
      query = "";
      filter = "all";
      page = 1;
      position = 0;
    } else if (action === "previous" || action === "next") {
      page += action === "next" ? 1 : -1;
      position = 0;
    }
    storage.setJson(STORAGE_KEYS.projectDirectoryFor(identity), { layout, sort });
    render();
    if (action === "previous" || action === "next")
      findElement(".project-directory-main", root)?.focus({ preventScroll: true });
  });
  root.closest(".workbench-view")?.addEventListener(
    "scroll",
    (event) => {
      if (root.querySelector(".project-directory") && event.target instanceof HTMLElement)
        position = event.target.scrollTop;
    },
    { passive: true },
  );
  getBrowserI18n().subscribe(() => {
    if (root.querySelector(".project-directory")) render();
  });
  return { render };
}
