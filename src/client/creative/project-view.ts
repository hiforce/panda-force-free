import { messageHtml, messageAttributes } from "../i18n.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";
import { creativeKindIcons } from "../../shared/creative/file-types.js";
import type { ContentProject } from "./contracts.js";

type Section = "content" | "documents" | "sessions" | "memory" | "publish";

export function projectCreationPath(scope: string, kind = "all", document = "", edit = false) {
  const query = new URLSearchParams({ id: scope });
  if (kind === "document") query.set("tab", "documents");
  else if (kind !== "all") query.set("kind", kind);
  if (document) query.set("document", document);
  if (edit) query.set("edit", "1");
  return "/project?" + query;
}

function memberAccount() {
  return (
    (globalThis as typeof globalThis & { __pandaForceIdentity?: { role?: string } }).__pandaForceIdentity?.role ===
    "member"
  );
}

export function projectOverviewHeading(
  t: Translate,
  scope: string,
  project?: ContentProject,
  actions = "",
  active: Section = "content",
) {
  const name = project?.name || t("common.project");
  const base = projectCreationPath(scope);
  const tabs = [
    ["content", "creative.create", base],
    ["sessions", "common.sessions", base + "&tab=sessions"],
    ["memory", "projects.memory", base + "&tab=memory"],
    ["publish", "creative.publish", "/publish?project=" + encodeURIComponent(scope)],
  ] as const;
  return `<header class="project-overview-heading">
    <div class="project-overview-identity">
      <nav class="project-breadcrumb" ${messageAttributes("aria-label", "projects.breadcrumb", {}, t)}><a class="icon-button" href="/projects" ${messageAttributes("aria-label", "common.projects", {}, t)} ${messageAttributes("title", "common.projects", {}, t)}>${codexIcon("arrowLeft")}<span class="sr-only">${messageHtml("common.projects", {}, t)}</span></a></nav>
      <details class="project-name-disclosure">
        <summary><h1 data-creative-heading data-project-breadcrumb-current data-i18n-ignore title="${e(name)}">${e(name)}</h1></summary>
        <p class="project-full-name" data-project-full-name data-i18n-ignore>${e(name)}</p>
      </details>
    </div>
    <nav class="resource-project-tabs" ${messageAttributes("aria-label", "projects.projectSections", {}, t)}>${tabs
      .filter(([key]) => key !== "sessions" || !memberAccount())
      .map(([key, label, path]) =>
        key === "content" && active === "documents"
          ? `<a class="active" href="${path}" aria-current="page">${messageHtml(label, {}, t)}</a>`
          : key === active
            ? `<span class="active" aria-current="page">${messageHtml(label, {}, t)}</span>`
            : `<a href="${path}">${messageHtml(label, {}, t)}</a>`,
      )
      .join("")}</nav>
    <button type="button" class="icon-button project-overview-settings" data-wb="project-edit" ${memberAccount() && !project?.canManageMembers ? "hidden" : ""} data-project-id="${e(scope)}" ${messageAttributes("aria-label", "common.editProject", {}, t)}>${codexIcon("settings")}</button>
  </header>${actions}`;
}

export function updateProjectHeading(host: HTMLElement, name: string) {
  const heading = host.querySelector<HTMLElement>("[data-creative-heading]");
  const fullName = host.querySelector("[data-project-full-name]");
  if (heading) {
    heading.textContent = name;
    heading.title = name;
  }
  if (fullName) fullName.textContent = name;
}

const projectCreationCategories = [
  ["all", "creative.all", "layout"],
  ["document", "creative.document", "file"],
  ["image", "creative.image", creativeKindIcons.image],
  ["slides", "creative.slides", creativeKindIcons.slides],
  ["web", "creative.web", creativeKindIcons.web],
] as const satisfies ReadonlyArray<readonly [string, MessageId, string]>;

export function projectCreationBody(t: Translate, scope: string, selected: string, actions: string, content: string) {
  const links = projectCreationCategories
    .map(
      ([kind, label, icon]) =>
        `<a data-creative-filter="${kind}" href="${projectCreationPath(scope, kind)}" ${kind === selected ? 'aria-current="page"' : ""} ${messageAttributes("aria-label", label, {}, t)} ${messageAttributes("data-tooltip", label, {}, t)}>${codexIcon(icon)}</a>`,
    )
    .join("");
  const legacyCategories = [
    ["video", "creative.video", ""],
    ["file", "creative.file", ""],
    ["trash", "creative.assetFileTrash", ""],
  ] as const;
  const options = [...projectCreationCategories, ...legacyCategories]
    .map(
      ([kind, label, icon]) =>
        `<option value="${kind}" data-route="${projectCreationPath(scope, kind)}" data-pf-message="${label}" ${kind === selected ? "selected" : ""} ${icon ? "" : `disabled data-legacy ${kind === selected ? "" : "hidden"}`}>${e(t(label))}</option>`,
    )
    .join("");
  return `<div class="project-creation-body">
    <aside class="project-creation-strip"><nav class="project-creation-categories works-category-nav" ${messageAttributes("aria-label", "creative.assetContentType", {}, t)}>${links}</nav></aside>
    <div class="project-creation-content">
      <div class="project-creation-tools"><div class="project-creation-picker">${codexIcon("layout")}<select id="projectCreationCategory" ${messageAttributes("aria-label", "creative.assetContentType", {}, t)}>${options}</select>${codexIcon("chevronDown")}</div>${actions}</div>
      ${content}
    </div>
  </div>`;
}

export function projectLoadingView(t: Translate, scope: string, project?: ContentProject, active: Section = "content") {
  return `<section class="project-overview" aria-busy="true">${projectOverviewHeading(t, scope, project, "", active)}<div class="project-overview-loading"><p role="status" data-content-workspace-status>${messageHtml("documents.loading", {}, t)}</p><div class="project-overview-placeholders" aria-hidden="true"><span></span><span></span><span></span></div></div></section>`;
}
