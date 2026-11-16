import { messageHtml, messageAttributes } from "../i18n.js";
import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import type { ContentProject } from "./contracts.js";

/** Project identity and navigation render before optional content code or data is available. */
export function projectOverviewHeading(t: Translate, scope: string, project?: ContentProject, actions?: string) {
  const name = project?.name || t("common.project");
  return `<nav class="project-breadcrumb" ${messageAttributes("aria-label", "projects.breadcrumb", {}, t)}><ol><li><a href="/projects" data-wb="route" data-route="projects">${messageHtml("common.projects", {}, t)}</a></li><li class="project-breadcrumb-current"><span aria-hidden="true">/</span><span data-project-breadcrumb-current aria-current="page" data-i18n-ignore title="${e(name)}">${e(name)}</span></li></ol></nav><header class="resource-heading project-overview-heading"><div class="project-overview-identity"><div class="project-overview-copy"><div class="project-overview-title"><h1 data-creative-heading data-i18n-ignore>${e(name)}</h1><code data-project-code data-i18n-ignore ${project?.code ? "" : "hidden"}>${e(project?.code || "")}</code></div><p data-project-description ${project?.description ? "data-i18n-ignore" : ""}>${project?.description ? e(project.description) : messageHtml("projects.overviewHint", {}, t)}</p></div></div><div class="creative-heading-actions">${actions ?? `<button type="button" class="wb-button" data-creative-new disabled>${codexIcon("file")}${messageHtml("projects.blankDocument", {}, t)}</button>`}</div><button type="button" class="icon-button project-overview-settings" data-wb="project-edit" ${(globalThis as typeof globalThis & { __pandaForceIdentity?: { role?: string } }).__pandaForceIdentity?.role === "member" ? "hidden" : ""} data-project-id="${e(scope)}" ${messageAttributes("aria-label", "common.editProject", {}, t)}>${codexIcon("settings")}</button></header>`;
}
export function projectOverviewTabs(
  t: Translate,
  scope: string,
  active: "content" | "documents" | "sessions" | "publish" = "content",
) {
  const base = "/project?id=" + encodeURIComponent(scope);
  const tabs = [
    ["content", "creative.content", base],
    ["documents", "documents.directory", base + "&tab=documents"],
    ["sessions", "common.sessions", base + "&tab=sessions"],
    ["publish", "creative.publish", "/publish?project=" + encodeURIComponent(scope)],
  ] as const;
  const visible = tabs.filter(
    ([key]) =>
      (globalThis as typeof globalThis & { __pandaForceIdentity?: { role?: string } }).__pandaForceIdentity?.role !==
        "member" || key !== "sessions",
  );
  return `<nav class="resource-project-tabs" ${messageAttributes("aria-label", "projects.projectSections", {}, t)}>${visible.map(([key, label, path]) => (key === active ? `<button class="active" type="button" aria-current="page">${messageHtml(label, {}, t)}</button>` : `<a href="${path}" data-wb="route" data-route="${path}">${messageHtml(label, {}, t)}</a>`)).join("")}</nav>`;
}
export function projectLoadingView(
  t: Translate,
  scope: string,
  project?: ContentProject,
  active: "content" | "documents" = "content",
) {
  return `<section class="project-overview" aria-busy="true">${projectOverviewHeading(t, scope, project, active === "documents" ? "" : undefined)}${projectOverviewTabs(t, scope, active)}<div class="project-overview-loading"><p role="status" data-content-workspace-status>${messageHtml("documents.loading", {}, t)}</p><div class="project-overview-placeholders" aria-hidden="true"><span></span><span></span><span></span></div></div></section>`;
}
export function projectEmptyView(t: Translate, writable: boolean) {
  return `<div class="project-overview-empty"><span class="project-overview-empty-icon" aria-hidden="true">${codexIcon("file")}</span><div><h2>${messageHtml("projects.emptyContentTitle", {}, t)}</h2><p>${messageHtml(writable ? "projects.emptyContentHint" : "projects.emptyContentReader", {}, t)}</p></div></div>`;
}
