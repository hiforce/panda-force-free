import type { Translate, MessageId } from "../../../shared/i18n/messages.js";
import { messageHtml as m, messageAttributes as attributes } from "../../i18n.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { codexIcon } from "../../codex-icons.js";
import { projectCreationBody } from "../../creative/project-view.js";
import { personalCategories, personalLibrarySurface } from "./personal-library.js";

export const authoringButton = (t: Translate, key: MessageId, name: string, extra = "", primary = false, icon = "") =>
  `<button type="button" class="wb-button${primary ? " primary" : ""}" data-authoring-action="${name}" ${extra}>${icon ? codexIcon(icon) : ""}${m(key, undefined, t)}</button>`;
export function authoringFrame(t: Translate, projectId: string, projectChrome = "") {
  const button = (key: MessageId, name: string, extra = "", primary = false, icon = "") =>
    authoringButton(t, key, name, extra, primary, icon);
  const personal = projectId === "personal";
  const editor = '<section class="document-editor document-authoring-editor" id="documentEditor"></section>';
  const back = projectId === "personal" ? "/create" : "/project?id=" + encodeURIComponent(projectId) + "&tab=documents";
  const backLabel = projectId === "personal" ? "creative.backCreate" : "documents.returnProject";
  const newActions =
    button(
      "creation.trigger",
      "new-ai",
      attributes("aria-label", "creation.title", undefined, t),
      !projectChrome,
      "plus",
    ) +
    button(
      "documents.newDocument",
      "new",
      attributes("title", "documents.newDocument", undefined, t) +
        " " +
        attributes("aria-label", "documents.newDocument", undefined, t),
      false,
      "plus",
    );
  const activity = button(
    "creation.showTasks",
    "ai-tasks",
    attributes("aria-label", "creation.showTasks", undefined, t),
    false,
    "list",
  );
  const more = `<details class="document-workspace-more"><summary ${attributes("aria-label", "documents.moreActions", undefined, t)}>${codexIcon("ellipsis")}${projectChrome ? "" : m("documents.moreActions", undefined, t)}</summary><div>${button("templates.createDocumentFromTemplate", "new-template")}${button("documents.newChild", "new-child")}${button("documents.moveDocument", "move-document")}${button("documents.deleteDocument", "trash-document")}<hr>${button("knowledge.open", "knowledge")}${button("documents.trash", "trash")}${button("documents.connectedSources", "sources")}</div></details>`;
  const actions = `<div class="documents-heading-actions">${
    projectChrome
      ? `<details class="project-create-menu"><summary class="wb-button primary">${codexIcon("plus")}${m("creative.new", undefined, t)}</summary><div>${newActions}${activity}</div></details>`
      : personal
        ? `<a class="authoring-workspace-back" href="/create?view=activity" ${attributes("aria-label", "creation.activityTitle", undefined, t)} ${attributes("title", "creation.activityTitle", undefined, t)}>${codexIcon("clock")}</a>`
        : newActions + activity
  }${more}</div>`;

  const heading =
    projectChrome ||
    `<header class="documents-heading"><div><a class="authoring-workspace-back" href="${back}" data-wb="route" data-route="${back}" ${attributes("aria-label", backLabel, undefined, t)} ${attributes("title", backLabel, undefined, t)}>${codexIcon("arrowLeft")}<span>${m(backLabel, undefined, t)}</span></a><h1>${m(projectId === "personal" ? "creative.create" : "documents.authoringTitle", undefined, t)}</h1></div>${actions}</header>`;
  const body = `${projectChrome ? `<div hidden data-project-reader-controls>${button("documents.backToDocuments", "close-project-document", attributes("aria-label", "documents.backToDocuments", undefined, t) + " data-project-reader-back", false, "arrowLeft")}</div>` : ""}
  <p id="documentNotice" class="documents-notice" role="status" hidden></p>
  <div class="document-authoring-context"><a class="authoring-project-back" href="${back}" data-wb="route" data-route="${back}" aria-label="${e(t(backLabel))}">${codexIcon("arrowLeft")}</a>${button(personal ? "creative.libraryCategories" : "documents.directoryToggle", "directory", 'aria-controls="authoringDirectory" aria-expanded="false"')}<nav id="authoringBreadcrumb" aria-label="${e(t("documents.folderLocation"))}"></nav>${button("documents.refreshTree", "refresh-tree", attributes("aria-label", "documents.refreshTree", undefined, t) + " " + attributes("title", "documents.refreshTree", undefined, t), false, "refreshCw")}</div>
  <div class="documents-layout document-authoring-layout"><button type="button" class="authoring-directory-scrim" data-authoring-action="directory-close" aria-label="${e(t("documents.closeDirectory"))}" tabindex="-1"></button><aside class="documents-directory" id="authoringDirectory" aria-label="${e(t(personal ? "creative.libraryCategories" : "documents.directory"))}"><header class="authoring-directory-heading"><button type="button" class="wb-button" data-authoring-action="directory-dismiss" aria-label="${e(t("documents.closeDirectory"))}">${codexIcon("x")}</button><strong>${m(personal ? "creative.libraryCategories" : "documents.directory", undefined, t)}</strong><div class="authoring-directory-utilities">${projectChrome ? button("documents.backToDocuments", "close-project-document", attributes("aria-label", "documents.backToDocuments", undefined, t) + " " + attributes("title", "documents.backToDocuments", undefined, t) + " data-project-desktop-close", false, "x") : ""}</div><details class="authoring-directory-add"><summary aria-label="${e(t("documents.create"))}">${codexIcon("plus")}</summary><div>${button("creation.trigger", "new-ai", "", true)}${button("documents.newDocument", "directory-new")}${button("documents.newChild", "directory-child")}${button("templates.createDocumentFromTemplate", "new-template")}</div></details></header>${personal ? "" : `<label class="sr-only" for="documentSearch">${m("documents.searchTree", undefined, t)}</label><input type="search" id="documentSearch" ${attributes("placeholder", "documents.searchTree", undefined, t)} autocomplete="off">`}<div class="authoring-directory-management"></div><div class="document-tree-status" id="documentTreeStatus" role="status" hidden><span></span>${button("documents.retryTreeChange", "retry-tree")}</div><div id="documentTree">${personal ? personalCategories(t) : ""}</div></aside>${personal ? personalLibrarySurface(t, editor) : editor}</div>
  ${personal || projectChrome ? "" : `<nav class="authoring-reader-tools" aria-label="${e(t("documents.documentActions"))}"><button type="button" data-authoring-action="reader-directory">${codexIcon("list")}<span>${m(personal ? "creative.libraryCategories" : "documents.directory", undefined, t)}</span></button><button type="button" data-authoring-action="reader-edit"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m16 3 5 5-13 13-5 1 1-5Z"/><path d="m14 5 5 5"/></svg><span>${m("documents.editDocument", undefined, t)}</span></button></nav>`}`;
  return heading + (projectChrome ? projectCreationBody(t, projectId, "document", actions, body) : body);
}
