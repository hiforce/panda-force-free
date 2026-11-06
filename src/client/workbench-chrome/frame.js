import { requireElement } from "../dom.js";
import { codexIcon } from "../codex-icons.js";
import { messageAttributes, messageHtml, setMessageHtml } from "../i18n.js";

/** Move existing controls once, preserving their identity and event owners. */
export function createWorkbenchFrame(t) {
  document.body.classList.add("panda-workspace");
  const heading = document.createElement("header");
  heading.id = "workspaceContextHeader";
  heading.className = "workspace-context-header";
  setMessageHtml(
    heading,
    `<nav class="workspace-context-path" ${messageAttributes("aria-label", "shell.workspaceContext", undefined, t)}><a href="/tasks" data-wb="route" data-route="tasks">${messageHtml("common.sessions", undefined, t)}</a>${codexIcon("chevronRight")}<button type="button" id="sessionHeadingProject"></button></nav><div class="workspace-context-row"><div class="workspace-context-actions"></div></div>`,
  );
  const title = requireElement("#threadTitle");
  const semanticTitle = document.createElement("h1");
  for (const attribute of title.attributes) semanticTitle.setAttribute(attribute.name, attribute.value);
  semanticTitle.textContent = title.textContent;
  title.replaceWith(semanticTitle);
  requireElement(".workspace-context-row", heading).prepend(requireElement(".thread-heading"));
  const actions = requireElement(".workspace-context-actions", heading);
  for (const selector of ["#toggleFilesPanel", "#toggleSummaryPanel", "#toggleSidePanel"])
    actions.append(requireElement(selector));
  requireElement(".conversation-shell").prepend(heading);

  const context = document.createElement("div");
  context.className = "workbench-global-context";
  setMessageHtml(
    context,
    `<span id="workbenchGlobalTitle">${messageHtml("common.workspace", undefined, t)}</span><button type="button" id="workbenchExitFocus" hidden>${codexIcon("columns2")}${messageHtml("shell.exitFocus", undefined, t)}</button>`,
  );
  requireElement(".top-actions").before(context);
  const launch = document.createElement("div");
  launch.className = "workbench-sidebar-launch";
  const newTask = requireElement("#newTask");
  newTask.before(launch);
  launch.append(newTask, requireElement("#toggleSidebar"));
  const restore = document.createElement("button");
  restore.id = "workspaceNavigationToggle";
  restore.type = "button";
  restore.className = "icon-button workspace-navigation-toggle";
  restore.setAttribute("aria-controls", "sidebar");
  setMessageHtml(restore, codexIcon("panelLeft"));
  for (const attribute of ["aria-label", "title"]) {
    restore.setAttribute(attribute, t("common.toggleSidebar"));
    restore.setAttribute("data-pf-" + attribute, "common.toggleSidebar");
  }
  requireElement(".window-brand").append(restore);
}
