import { escapeHtml as escape } from "../shared/html.js";
import { findElement, requireElement } from "./dom.js";
import { messageAttributes, messageHtml, setMessageHtml } from "./i18n.js";
/** Owns a cohesive workbench presentation surface. */
export function createWorkbenchSearch({ t, dialog, labels, allProjects, visibleThreads, modal }) {
  function commandResults(value = "") {
    const q = value.toLocaleLowerCase();
    const list = [
      ...["workspace", "tasks", "projects", "deliverables", "connections", "settings"].map((page) => ({
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
    modal(
      "common.searchAnything",
      `<p class="wb-keyboard-tip">${messageHtml("workbench.ctrlCmdKSearchesCtrlCmdShiftKCreatesA", undefined, t)}</p><input id="wbCommandQuery" type="search" autocomplete="off" ${messageAttributes("aria-label", "common.searchAnything", undefined, t)}><div id="wbCommandResults"></div>`,
    );
    commandResults();
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
