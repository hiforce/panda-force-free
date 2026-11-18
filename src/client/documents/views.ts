import { escapeHtml as e } from "../../shared/html.js";
import { messageHtml, messageAttributes } from "../i18n.js";
import type { MessageId, Translate } from "../../shared/i18n/messages.js";
import type { DocumentDetail, DocumentRecord, DocumentSpace } from "../../shared/documents/contracts.js";
import type { DocumentDraft } from "./drafts.js";
import { codexIcon } from "../codex-icons.js";

export function action(t: Translate, id: MessageId, name: string, extra = "", primary = false) {
  return `<button type="button" class="wb-button${primary ? " primary" : ""}" data-doc-action="${name}" ${extra}>${messageHtml(id, undefined, t)}</button>`;
}
export function frame(t: Translate, projectId: string, spaces: DocumentSpace[], selected: string, packages = false) {
  return `<div class="documents-heading"><div><a data-wb="route" data-route="/project?id=${encodeURIComponent(projectId)}" href="/project?id=${encodeURIComponent(projectId)}">${messageHtml("documents.returnProject", undefined, t)}</a><h1>${messageHtml("documents.title", undefined, t)}</h1><p>${messageHtml("documents.subtitle", undefined, t)}</p></div><div class="documents-heading-actions">${packages ? action(t, "plugins.open", "packages") : ""}${action(t, "documents.createSpace", "new-space", "", true)}</div></div>
    <div class="documents-notice" id="documentNotice" role="status" hidden></div>
    <div class="documents-spaces"><label for="documentSpace">${messageHtml("documents.spaces", undefined, t)}</label><select id="documentSpace">${spaces.map((s) => `<option value="${e(s.id)}" ${s.id === selected ? "selected" : ""}>${e(s.name)} · ${e(s.engine)}</option>`).join("")}</select><span id="documentSourceInfo"></span><div id="documentSpaceActions"></div></div>
    <div class="documents-layout"><aside class="documents-directory"><label class="sr-only" for="documentSearch">${messageHtml("documents.search", undefined, t)}</label><input id="documentSearch" type="search" ${messageAttributes("placeholder", "documents.search", undefined, t)} autocomplete="off"><div id="documentTree"></div></aside><section id="documentEditor" class="document-editor" aria-label="${e(t("documents.editorLabel"))}"></section></div>`;
}
export function empty(t: Translate, title: MessageId, hint?: MessageId) {
  return `<div class="documents-empty"><span class="documents-empty-symbol" aria-hidden="true">▤</span><h2>${messageHtml(title, undefined, t)}</h2>${hint ? `<p>${messageHtml(hint, undefined, t)}</p>` : ""}</div>`;
}
interface Directory {
  files: DocumentRecord[];
  children: Map<string, Directory>;
}
export function directory(
  t: Translate,
  records: DocumentRecord[],
  selected: string,
  more: boolean,
  collapsed: Set<string>,
) {
  if (!records.length) return empty(t, "documents.noDocuments", "documents.noDocumentsHint");
  const root: Directory = { files: [], children: new Map() };
  for (const record of records) {
    const parts = record.path.split("/");
    parts.pop();
    let parent = root;
    for (const part of parts) {
      let child = parent.children.get(part);
      if (!child) parent.children.set(part, (child = { files: [], children: new Map() }));
      parent = child;
    }
    parent.files.push(record);
  }
  const render = (node: Directory, path = ""): string =>
    [...node.children.entries()]
      .map(([name, child]) => {
        const key = path + name + "/";
        return `<details data-directory="${e(key)}" ${collapsed.has(key) ? "" : "open"}><summary>${e(name)}</summary><div>${render(child, key)}</div></details>`;
      })
      .join("") +
    node.files
      .map(
        (d) =>
          `<button type="button" class="document-file ${selected === d.id ? "selected" : ""}" data-doc-action="select" data-id="${e(d.id)}" title="${e(d.path)}" ${selected === d.id ? 'aria-current="true"' : ""}><strong>${e(d.title)}</strong><small>${e(d.path.split("/").pop() || d.path)}</small></button>`,
      )
      .join("");
  return render(root) + (more ? action(t, "documents.more", "more") : "");
}
export function editor(
  t: Translate,
  detail: DocumentDetail,
  draft: Pick<DocumentDraft, "title" | "locale" | "content" | "body">,
  options: { publishing?: boolean; authoring?: boolean } = {},
) {
  if (draft.body)
    return `<header class="document-editor-header document-authoring-editor-header"><div class="document-editor-identity">${options.authoring ? '<div class="document-editor-breadcrumb-slot"></div>' : ""}<span id="documentModeLabel"></span><span id="documentSaveState" role="status"></span><span class="document-revision">${messageHtml("documents.revision", { number: detail.document.revision }, t)}</span></div><div class="document-editor-actions"><button type="button" class="wb-button document-insert-trigger" data-doc-action="insert-content" ${messageAttributes("aria-label", "documents.insertContent", undefined, t)} ${messageAttributes("title", "documents.insertContent", undefined, t)} aria-haspopup="menu" aria-expanded="false">${codexIcon("plus")}</button>${action(t, "documents.read", "preview")}${action(t, "documents.editDocument", "edit")}${options.publishing ? action(t, "documents.publishDocument", "publishing", "", true) : ""}<details class="document-editor-more"><summary>${messageHtml("documents.moreActions", undefined, t)}</summary><div>${options.authoring ? `<button type="button" class="wb-button" data-authoring-action="reader-directory">${messageHtml("documents.directory", undefined, t)}</button>` : ""}${action(t, "documents.documentProperties", "properties")}${action(t, "documents.history", "history")}${action(t, "documents.assets", "images")}${action(t, "documents.markdownExport", "export")}${action(t, "documents.save", "save")}</div></details></div></header><div class="document-canvas">${options.authoring ? '<div class="document-toolbar-marker" aria-hidden="true" hidden></div><div id="documentToolbarSlot" class="document-toolbar-slot" hidden></div>' : ""}<div class="document-editor-fields document-rich-title"><label class="sr-only" for="documentTitle">${messageHtml("documents.articleTitle", undefined, t)}</label><textarea id="documentTitle" rows="1" maxlength="200" data-i18n-ignore>${e(draft.title)}</textarea><h1 id="documentReadTitle" data-i18n-ignore>${e(draft.title)}</h1><input id="documentLocale" value="${e(draft.locale)}" hidden></div><div class="document-rich-status"><span id="documentLanguage" data-i18n-ignore>${e(draft.locale)}</span><span>${messageHtml("documents.autosaveHint", undefined, t)}</span></div><div id="documentRichEditor" aria-label="${e(t("documents.richEditorLabel"))}">${empty(t, "documents.loadingEditor")}</div><textarea id="documentSource" hidden>${e(draft.content)}</textarea><div id="documentPreview" hidden></div></div>`;
  return `<header class="document-editor-header"><div><span class="document-path" data-i18n-ignore>${e(detail.document.path)}</span><span class="document-revision">${messageHtml("documents.revision", { number: detail.document.revision }, t)}</span></div><div class="document-editor-actions">${action(t, "publishing.open", "publishing")}${action(t, "documents.assets", "images")}${detail.sourceMode === "external" ? action(t, "documents.importImages", "import-images") : ""}${action(t, "documents.languages", "languages")}${action(t, "documents.history", "history")}${action(t, "documents.save", "save", "", true)}</div></header>
    <div class="document-editor-fields"><label for="documentTitle">${messageHtml("documents.articleTitle", undefined, t)}</label><input id="documentTitle" maxlength="200" value="${e(draft.title)}"><label for="documentLocale">${messageHtml("documents.locale", undefined, t)}</label><input id="documentLocale" maxlength="35" value="${e(draft.locale)}"></div>
    <div class="document-editor-tabs" role="group" aria-label="${e(t("documents.editorLabel"))}">${action(t, "documents.edit", "edit", 'aria-pressed="true"')}${action(t, "documents.preview", "preview", 'aria-pressed="false"')}<span id="documentSaveState" role="status"></span></div>
    <textarea id="documentSource" class="document-source" spellcheck="false" ${messageAttributes("aria-label", "documents.editorLabel", undefined, t)}>${e(draft.content)}</textarea>
    <div id="documentPreview" class="document-preview" hidden></div><p class="document-format-hint">${messageHtml("documents.formatNotice", undefined, t)}</p>`;
}
export function field(t: Translate, label: MessageId, name: string, value = "", extra = "") {
  return `<label for="doc-${name}">${messageHtml(label, undefined, t)}</label><input id="doc-${name}" name="document-${name}" value="${e(value)}" ${extra}>`;
}
