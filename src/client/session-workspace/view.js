import { requireElement } from "../dom.js";
import { codexIcon } from "../codex-icons.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";

/** Static shell. Runtime counters and project names are written separately as text. */
export function createSessionWorkspaceView(t) {
  const inspector = document.createElement("dialog");
  inspector.id = "sessionInspector";
  inspector.className = "session-inspector";
  inspector.setAttribute("aria-labelledby", "sessionInspectorTitle");
  const label = (key) => messageHtml(key, undefined, t);
  const attr = (key) => messageAttributes("aria-label", key, undefined, t);
  setMessageHtml(
    inspector,
    `
    <div class="session-sheet-handle" aria-hidden="true"></div>
    <header class="session-inspector-heading"><h2 id="sessionInspectorTitle" tabindex="-1">${label("sessionview.title")}</h2><button type="button" class="icon-button" data-session-action="close" ${attr("common.close")}>${codexIcon("x")}</button></header>
    <nav class="session-inspector-tabs" role="tablist" ${attr("sessionview.title")}>
      <button id="sessionOverviewTab" type="button" role="tab" aria-controls="sessionOverview" aria-selected="true" data-session-action="overview">${label("sessionview.overview")}</button>
      <button id="sessionToolsTab" type="button" role="tab" aria-controls="sessionToolsView" aria-selected="false" tabindex="-1" data-session-action="tools">${label("sessionview.tools")}<small id="sessionToolsCount"></small></button>
    </nav>
    <div class="session-inspector-scroll" id="sessionInspectorScroll">
      <section id="sessionOverview" role="tabpanel" aria-labelledby="sessionOverviewTab">
        <section class="session-section session-usage-section" id="sessionUsageSection"><div class="session-section-heading"><h3>${label("sessionview.sessionUsage")}</h3><button type="button" class="icon-button small" data-session-action="usage" ${attr("sessionview.sessionUsage")}>${codexIcon("info")}</button></div><div id="sessionUsageView"></div></section>
        <section class="session-section" id="sessionExecutionSection"><div class="session-section-heading"><h3>${label("sessionview.execution")}</h3><span id="sessionElapsed"></span></div><div id="sessionExecutionSlot"></div><p class="session-caption" id="sessionExecutionHint"></p><button type="button" class="session-pending-action" id="sessionPendingAction" data-session-action="pending" hidden>${label("sessionview.reviewRequest")}${codexIcon("arrowUpRight")}</button></section>
        <section class="session-section"><div class="session-section-heading"><h3>${label("sessionview.projectContext")}</h3></div><button type="button" class="session-project-selector" id="sessionAssociateProject" data-session-action="project">${codexIcon("folderOpen")}<span><strong id="sessionProjectName"></strong><small id="sessionProjectCode"></small></span>${codexIcon("chevronDown")}</button><div class="session-working-folder">${codexIcon("folder")}<span id="sessionWorkingFolder"></span></div></section>
        <section class="session-section"><div class="session-section-heading"><h3>${label("sessionview.configuration")}</h3></div><div class="session-configuration" id="sessionConfiguration"></div><div class="session-configuration-mirror"><button type="button" data-session-action="model">${codexIcon("slidersHorizontal")}<span><strong id="sessionMirrorModel"></strong><small id="sessionMirrorEffort"></small></span>${codexIcon("chevronRight")}</button><button type="button" data-session-action="permissions">${codexIcon("shield")}<span><strong id="sessionMirrorPermission"></strong><small>${label("common.permissions")}</small></span>${codexIcon("chevronRight")}</button></div></section>
        <details class="session-goal-plan" id="sessionGoalPlan" hidden><summary>${codexIcon("list")}<span>${label("sessionview.goalPlan")}</span>${codexIcon("chevronDown")}</summary><div id="sessionGoalSlot"></div></details>
      </section>
      <section id="sessionToolsView" role="tabpanel" aria-labelledby="sessionToolsTab" hidden><div id="sessionToolsListView"><p class="session-caption">${label("sessionview.toolHint")}</p><input id="sessionToolSearch" type="search" class="session-field" ${messageAttributes("placeholder", "sessionview.searchTools", undefined, t)} ${attr("sessionview.searchTools")} /><div id="sessionToolsList"></div><button type="button" class="session-button session-full-button" data-session-action="customize">${codexIcon("plus")}${label("sessionview.manageTools")}</button></div><div id="sessionLocalTool" hidden></div></section>
    </div>
    <footer class="session-inspector-footer" id="sessionInspectorFooter"><div class="session-section-heading"><h3>${label("sessionview.quickTools")}</h3><button type="button" class="session-text-button" data-session-action="customize">${label("sessionview.customize")}</button></div><div class="session-tool-shortcuts" id="sessionToolShortcuts"></div></footer>
  `,
  );
  requireElement("#app").append(inspector);
  const info = document.createElement("button");
  info.id = "sessionInfoButton";
  info.type = "button";
  info.className = "icon-button session-info-button";
  info.hidden = true;
  info.setAttribute("aria-controls", inspector.id);
  info.setAttribute("aria-expanded", "false");
  setMessageHtml(info, codexIcon("panelRight"));
  requireElement(".workspace-context-actions").append(info);
  const actions = document.createElement("button");
  actions.id = "sessionActionsButton";
  actions.type = "button";
  actions.className = "icon-button session-actions-button";
  actions.hidden = true;
  setMessageHtml(actions, codexIcon("ellipsis"));
  info.before(actions);
  const summary = document.createElement("div");
  summary.id = "sessionMobileSummary";
  summary.className = "session-mobile-summary";
  summary.hidden = true;
  setMessageHtml(
    summary,
    `<button type="button" data-session-action="open"><i id="sessionMobileStatusDot"></i><span id="sessionMobileStatus"></span><span id="sessionMobileElapsed"></span></button><button type="button" data-session-action="usage" ${attr("sessionview.sessionUsage")}>${codexIcon("chartNoAxesColumn")}<span id="sessionMobileTokens">—</span>${codexIcon("chevronUp")}</button>`,
  );
  requireElement("#composer").before(summary);
  const usageDialog = document.createElement("dialog");
  usageDialog.id = "sessionUsageDialog";
  const toolsDialog = document.createElement("dialog");
  toolsDialog.id = "sessionToolsDialog";
  const actionsDialog = document.createElement("dialog");
  actionsDialog.id = "sessionActionsDialog";
  for (const { dialog, title, content } of [
    {
      dialog: usageDialog,
      title: "sessionview.sessionUsage",
      content: `<p class="session-caption">${label("sessionview.usageHint")} ${label("sessionview.cachedHint")}</p><div id="sessionUsageDialogContent"></div>`,
    },
    { dialog: toolsDialog, title: "sessionview.manageTools", content: `<div id="sessionToolsManager"></div>` },
    { dialog: actionsDialog, title: "sessionview.sessionActions", content: `<div id="sessionActionsContent"></div>` },
  ]) {
    const id = dialog.id;
    dialog.className = "session-dialog";
    dialog.setAttribute("aria-labelledby", id + "Title");
    setMessageHtml(
      dialog,
      `<header class="session-dialog-heading"><div><p class="session-eyebrow">PandaForce</p><h2 id="${id}Title" tabindex="-1">${label(title)}</h2></div><button type="button" class="icon-button" data-session-dismiss ${attr("common.close")}>${codexIcon("x")}</button></header><div class="session-dialog-body">${content}</div>`,
    );
    document.body.append(dialog);
  }
  const search = document.createElement("button");
  search.id = "sessionWorkspaceSearch";
  search.type = "button";
  search.className = "session-drawer-search";
  setMessageHtml(search, `${codexIcon("search")}<span>${label("common.searchAnything")}</span>`);
  requireElement(".sidebar-top").append(search);
  return { inspector, info, actions, summary };
}
