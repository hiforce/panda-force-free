import { escapeHtml as escape } from "../shared/html.js";
import { findElement, requireElement } from "./dom.js";
import { messageAttributes, messageHtml, setMessageHtml } from "./i18n.js";
import { contentSearchPane } from "./search/content.js";
/** Owns a cohesive workbench presentation surface. */
export function createWorkbenchSearch({ t, dialog, labels, allProjects, visibleThreads, modal }) {
  let content = null,
    contentHost = null;
  const closeContent = () => {
    content?.close();
    content = null;
    contentHost = null;
  };
  dialog.addEventListener("close", closeContent);
  new MutationObserver(() => {
    if (contentHost && !dialog.contains(contentHost)) closeContent();
  }).observe(dialog, { childList: true });
  function commandResults(value = "") {
    const q = value.toLocaleLowerCase();
    const list = [
      ...["workspace", "bots", "tasks", "create", "projects", "skills", "publish", "settings"].map((page) => ({
        label: t(labels[page]),
        action: "route",
        attrs: `data-route="${page}"`,
      })),
      ...visibleThreads()
        .slice(0, 1000)
        .map((x) => ({
          label: x.name || x.preview || t("workbench.untitledSession"),
          action: "task",
          attrs: `data-id="${escape(x.id)}"`,
        })),
      ...allProjects().map((p) => ({
        label: p.name + " · " + p.code,
        action: "project",
        attrs: `data-project-id="${escape(p.id)}"`,
      })),
    ]
      .filter((x) => x.label.toLocaleLowerCase().includes(q))
      .slice(0, 30);
    setMessageHtml(
      findElement("#wbCommandResults", dialog),
      list.length
        ? list
            .map(
              (x) =>
                `<button type="button" data-i18n-ignore data-wb="${x.action}" ${x.attrs}>${escape(x.label)}</button>`,
            )
            .join("")
        : `<p>${messageHtml("common.noResultsFound", undefined, t)}</p>`,
    );
  }
  function openSearch() {
    closeContent();
    modal(
      "search.title",
      `<nav class="resource-type-tabs" aria-label="${escape(t("search.searchType"))}"><button type="button" data-search-tab="commands" aria-pressed="true">${messageHtml("search.commands", undefined, t)}</button><button type="button" data-search-tab="content" aria-pressed="false">${messageHtml("search.content", undefined, t)}</button></nav><div data-search-commands><p class="wb-keyboard-tip">${messageHtml("workbench.ctrlCmdKSearchesCtrlCmdShiftKCreatesA", undefined, t)}</p><input id="wbCommandQuery" type="search" autocomplete="off" ${messageAttributes("aria-label", "common.searchAnything", undefined, t)}><div id="wbCommandResults"></div></div><div class="wb-form" data-search-content hidden></div>`,
      "search",
    );
    commandResults();
    for (const button of dialog.querySelectorAll("[data-search-tab]"))
      button.onclick = () => {
        const isContent = button.dataset.searchTab === "content";
        closeContent();
        requireElement("[data-search-commands]", dialog).hidden = isContent;
        const pane = requireElement("[data-search-content]", dialog);
        contentHost = pane;
        pane.hidden = !isContent;
        for (const tab of dialog.querySelectorAll("[data-search-tab]"))
          tab.setAttribute("aria-pressed", String(tab === button));
        if (isContent) content = contentSearchPane(pane, t, allProjects());
        else requireElement("#wbCommandQuery", dialog).focus();
      };
    const input = requireElement("input", dialog);
    input.oninput = () => commandResults(input.value);
    requireElement("input", dialog).onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        const first = findElement("#wbCommandResults button", dialog);
        if (first) {
          e.preventDefault();
          if (e.key === "Enter") first.click();
          else first.focus();
        }
      }
    };
    requireElement("input", dialog).focus();
  }
  return { commandResults, openSearch };
}
