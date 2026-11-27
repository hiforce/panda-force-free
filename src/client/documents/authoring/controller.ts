import { updateProjectHeading } from "../../creative/project-view.js";
import { codexIcon } from "../../codex-icons.js";
import type { Translate } from "../../../shared/i18n/messages.js";
import type { DocumentTreeMutation } from "../../../shared/documents/navigation.js";
import type { CreativeAsset } from "../../../shared/creative/assets.js";
import { setMessageHtml, setOpaqueText, localizeText, errorText, getBrowserI18n, messageHtml } from "../../i18n.js";
import { escapeHtml as e } from "../../../shared/html.js";

import { FileDocumentEditor } from "../files/editor.js";
import { documentJson } from "../api.js";
import { DocumentEditor } from "../editor.js";
import type { DocumentPublicationActions } from "../action-port.js";
import type { DocumentEditorPort } from "../editor-port.js";
import { DocumentDrafts } from "../drafts.js";
import { DocumentModal } from "../modal.js";
import { DocumentDialogs } from "../dialogs.js";
import { DocumentResources } from "../resources.js";
import { DocumentApiError } from "../api.js";
import { empty } from "../views.js";
import { authoringFrame, authoringButton as button } from "./views.js";
import { documentTreeApi } from "./tree-api.js";
import { DocumentTreeSession } from "./tree-session.js";
import { treeRecovery } from "./tree-recovery.js";
import { DocumentTreeIndex } from "./tree-model.js";
import { DocumentTreeView } from "./tree-view.js";
import { DocumentTreeDrag } from "./tree-drag.js";
import { DocumentTreeActions } from "./tree-actions.js";
import { DocumentTreeMenu } from "./tree-menu.js";
import { DocumentTreeTrash } from "./trash.js";
import { AuthoringDirectory } from "./directory.js";
import { AuthoringHeader } from "./header.js";
import { AuthoringAssetDirectory } from "./asset-directory.js";
import { DocumentTemplatePicker } from "./template-picker.js";
import { LazyDocumentCreationPanel } from "../../creation/lazy-panel.js";
import { KnowledgePanel, KnowledgeRecordView } from "../../knowledge/lazy.js";
import { LazyCreativeAssetsPanel } from "../../creative/assets-lazy.js";
import { copyPersonalDocument } from "../../creative/document-copy.js";
import { PersonalCreationLibrary, personalCategory, type PersonalCategory } from "./personal-library.js";

/** The workspace coordinates feature lifetimes. Tree, source editing and connected sources own separate state. */
export function createProjectDocumentWorkspace(options: {
  t: Translate;
  identityKey: string;
  sources: { show(host: HTMLElement, project: string): void; hide(): void };
  publishing: DocumentPublicationActions;
  projects?: () => readonly { id: string; name: string }[];
  onDocumentFocusChanged?: (active: boolean) => void;
  projectFrame?: (project: string) => string;
}) {
  const { t } = options,
    root = document.createElement("section");
  root.className = "documents-workspace project-document-authoring";
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector);
  let treeControlKey = "",
    treeControlRoot: Element | null = null;
  let focused = false;
  function focusDocument(active: boolean) {
    if (focused === active) return;
    focused = active;
    options.onDocumentFocusChanged?.(active);
  }
  let projectId = "",
    epoch = 0,
    lastRequested = "",
    lastKnowledge = "",
    sourceView = false,
    embedded = false,
    directoryScroll = 0,
    fileMode = false,
    workspaceReady = false,
    opening = false,
    selectionEpoch = 0,
    capabilityRead: AbortController | null = null,
    index = new DocumentTreeIndex({ projectId: "", version: 0, nodes: [] }),
    drag: DocumentTreeDrag | null = null;
  const modal = new DocumentModal(t, "authoringDocumentDialog"),
    dialogs = new DocumentDialogs(t, modal),
    menu = new DocumentTreeMenu(t),
    view = new DocumentTreeView(t, options.identityKey);
  const directory = new AuthoringDirectory(root, controls);
  const header = new AuthoringHeader(root, t);
  const inlineAsset = new LazyCreativeAssetsPanel(t, "personalCreationAssetActions", options.identityKey);
  const files = new AuthoringAssetDirectory(
    t,
    options.identityKey,
    () => {
      if (directory.mobile.matches && root.classList.contains("directory-open")) directory.set(false, true);
      menu.close();
      drag?.cancel();
    },
    (asset) => void openPersonalAsset(asset, asset.version, true),
    (available) => personal?.setImportAvailable(available),
  );
  let personal: PersonalCreationLibrary | null = null,
    personalKey = "",
    personalListKey = "";
  const session = new DocumentTreeSession(documentTreeApi, treeRecovery(options.identityKey), renderTree);
  const onSaved = (record: import("../../../shared/documents/contracts.js").DocumentRecord) => {
    session.update(record);
    notice("");
  };
  const legacyEditor = () =>
    new DocumentEditor(
      t,
      new DocumentDrafts(options.identityKey),
      dialogs,
      onSaved,
      report,
      new DocumentResources(t, modal),
      options.publishing,
      { authoring: true, autosave: true, stateChanged: controls },
    );
  let editor: DocumentEditorPort = legacyEditor();
  const actions = new DocumentTreeActions(t, modal, session, canChange, completed);
  const templatePicker = new DocumentTemplatePicker(t);
  const creation = new LazyDocumentCreationPanel(t, options.identityKey);
  const knowledge = new KnowledgePanel(t, options.identityKey);
  const recordView = new KnowledgeRecordView(t, () => {
    lastKnowledge = "";
    const url = new URL(location.href);
    if (url.pathname === "/documents" && url.searchParams.get("project") === projectId) {
      url.searchParams.delete("knowledge");
      history.replaceState(history.state, "", url);
    }
  });
  const trash = new DocumentTreeTrash(t, session, (result) => completed(result, "restore"), report);
  function notice(message: string, failed = false) {
    const node = get("#documentNotice");
    if (node) {
      setOpaqueText(node, message);
      node.hidden = !message;
      node.dataset.error = String(failed);
    }
  }
  function report(error: unknown) {
    if (root.isConnected && !sourceView)
      notice(errorText(error instanceof DocumentApiError ? error.payload : null, t, "documents.unavailable"), true);
  }
  function canChange(ids: string[]) {
    return !ids.includes(editor.id) || (!editor.changed && !editor.saving);
  }
  function controls() {
    root.classList.toggle("file-document-mode", fileMode);
    root.classList.toggle("document-open", !!editor.record);
    root.classList.toggle("is-editing", editor.editing);
    document.body.classList.toggle("document-focus-editing", root.isConnected && !sourceView && editor.editing);
    document.body.classList.toggle(
      "project-creation-reading",
      embedded && root.isConnected && !sourceView && !!editor.record,
    );
    focusDocument(root.isConnected && !sourceView && !embedded);
    const more = get(".document-workspace-more"),
      target = get(
        directory.mobile.matches
          ? embedded
            ? ".authoring-directory-utilities"
            : ".authoring-directory-management"
          : ".documents-heading-actions",
      );
    if (more && target && more.parentElement !== target) target.append(more);
    for (const node of root.querySelectorAll<HTMLButtonElement>("[data-authoring-action]")) {
      const action = node.dataset.authoringAction || "",
        write = [
          "new",
          "new-ai",
          "ai-tasks",
          "new-template",
          "new-child",
          "directory-new",
          "directory-child",
          "move-document",
          "trash-document",
        ].includes(action);
      node.disabled =
        (write && (!workspaceReady || session.busy || session.loading || !!session.pending || opening)) ||
        (action === "refresh-tree" && session.loading) ||
        (["new-child", "directory-child", "move-document", "trash-document"].includes(action) &&
          !index.byId.has(editor.id)) ||
        (["trash-document"].includes(action) && !canChange([editor.id]));
      if (["new-template", "new-ai", "ai-tasks", "knowledge"].includes(action)) node.hidden = !fileMode;
      if (action === "knowledge") node.disabled = !workspaceReady || session.loading;
      if (action === "close-content" || action === "close-project-document") node.disabled = editor.saving || opening;
      if (action === "close-project-document") node.hidden = !editor.record;
      if (action === "new") node.classList.toggle("primary", !fileMode);
    }
    header.update(
      index.ancestors(editor.id).map((node) => node.document.title),
      directory.mobile.matches,
      personal ? "creative.myWork" : "documents.rootFolder",
    );
    const search = get<HTMLInputElement>("#documentSearch");
    if (search) search.disabled = !workspaceReady;
    const status = get("#documentTreeStatus");
    if (status) {
      status.hidden = !session.busy && !session.loading && !session.pending;
      localizeText(
        status.querySelector("span"),
        session.loading
          ? "documents.loading"
          : session.busy
            ? "documents.updatingTree"
            : "documents.uncertainTreeChange",
        undefined,
        t,
      );
      const retry = status.querySelector<HTMLButtonElement>("button")!;
      retry.hidden = session.busy || session.loading || !session.pending;
      retry.disabled = session.busy || session.loading;
    }
    get("#documentTree")?.setAttribute("aria-busy", String(session.busy || session.loading));
    const first = get("#documentTree")?.firstElementChild || null,
      key = JSON.stringify([workspaceReady, session.busy, session.loading, !!session.pending, opening]);
    if (first !== treeControlRoot || key !== treeControlKey) {
      treeControlRoot = first;
      treeControlKey = key;
      root
        .querySelectorAll<HTMLButtonElement>(".document-tree-title")
        .forEach((node) => (node.disabled = !workspaceReady || session.busy || opening));
      root
        .querySelectorAll<HTMLButtonElement>(".document-tree-more,.document-tree-handle")
        .forEach((node) => (node.disabled = session.busy || session.loading || !!session.pending || opening));
    }
  }
  function renderTree() {
    if (sourceView) return;
    index = new DocumentTreeIndex(session.snapshot);
    if (personal) {
      personal.update();
      files.setCardView(personal.view === "cards");
      personal.documents(
        index,
        get<HTMLInputElement>("#documentSearch")?.value || "",
        session.loading,
        !workspaceReady || session.busy || opening,
      );
      controls();
      return;
    }
    const host = get("#documentTree");
    if (host) {
      const top = host.scrollTop,
        active = document.activeElement;
      const fileFocus = active instanceof HTMLElement && files.element.contains(active) ? active : null;
      if (session.loading && !index.tree.nodes.length) setMessageHtml(host, empty(t, "documents.loading"));
      else view.render(host, index, editor.id, session.busy || session.loading || !!session.pending || opening);
      host.append(files.element);
      host.scrollTop = top;
      fileFocus?.focus({ preventScroll: true });
    }
    controls();
  }
  function personalLocation() {
    const url = new URL(location.href);
    return (url.pathname === "/documents" && url.searchParams.get("project") === "personal") ||
      (url.pathname === "/create" && (url.searchParams.get("view") === "works" || url.searchParams.has("asset")))
      ? url
      : null;
  }
  function personalRouteKey(url: URL) {
    return JSON.stringify(["category", "document", "asset", "assetVersion"].map((key) => url.searchParams.get(key)));
  }
  function personalAddress(id = "", asset = "", version?: string, push = false) {
    const url = personalLocation();
    if (!url || !personal) return;
    // Keep the works alias recognizable after closing an asset-only deep link.
    if (url.pathname === "/create") url.searchParams.set("view", "works");
    url.searchParams.set("category", personal.category);
    for (const [key, value] of [
      ["document", id],
      ["asset", asset],
      ["assetVersion", version],
      ["edit", ""],
    ] as const) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    personalKey = personalRouteKey(url);
    history[push ? "pushState" : "replaceState"](history.state, "", url);
  }
  function address(id: string, fromList = false) {
    if (personal) return personalAddress(id, "", undefined, fromList);
    const url = new URL(location.href);
    if (
      embedded
        ? url.pathname !== "/project" || url.searchParams.get("id") !== projectId
        : url.pathname !== "/documents" || url.searchParams.get("project") !== projectId
    )
      return;
    if (id) url.searchParams.set("document", id);
    else url.searchParams.delete("document");
    history.replaceState(history.state, "", url);
    lastRequested = id;
  }
  async function select(id: string, edit = false, fromList = false) {
    if (!workspaceReady) return;
    const node = index.byId.get(id);
    if (!node) return;
    const scroll = root.closest(".workbench-view");
    if (embedded && directory.mobile.matches && !editor.record) directoryScroll = scroll?.scrollTop ?? 0;
    const generation = epoch,
      selection = ++selectionEpoch;
    opening = true;
    if (personal) {
      inlineAsset.close();
      showPersonalCategory("document");
      personal.read("document", id, node.document.title, fromList);
      setMessageHtml(get("[data-personal-asset] [data-asset-detail]"), "");
    }
    menu.close();
    trash.close();
    controls();
    try {
      await editor.select(id, node.document.spaceId);
      if (generation !== epoch || selection !== selectionEpoch || sourceView) return;
      if (editor.id !== id) return;
      view.remember(id);
      view.reveal(index, id);
      address(id, fromList);
      directory.set(false);
      if (edit) {
        editor.beginEditing();
        const title = get<HTMLInputElement | HTMLTextAreaElement>("#documentTitle");
        title?.focus({ preventScroll: true });
        title?.select();
      }
      renderTree();
      if (personal && !edit) get<HTMLElement>("[data-personal-reader-title]")?.focus({ preventScroll: true });
    } catch (error) {
      if (!personal || generation !== epoch || selection !== selectionEpoch) throw error;
      setMessageHtml(
        get("#documentEditor"),
        empty(t, "documents.unavailable") +
          `<button type="button" class="wb-button" data-personal-document="${e(id)}">${messageHtml("common.retry", {}, t)}</button>`,
      );
      report(error);
    } finally {
      if (generation === epoch && selection === selectionEpoch) {
        opening = false;
        controls();
        if (embedded && directory.mobile.matches && !edit && editor.id === id) {
          scroll?.scrollTo(0, 0);
          get<HTMLButtonElement>("[data-project-reader-back]")?.focus({
            preventScroll: true,
          });
        }
      }
    }
  }
  function showPersonalCategory(category: PersonalCategory, trashFiles = false) {
    if (!personal) return;
    const key = category + (trashFiles ? ":files" : ""),
      changed = personalListKey !== key;
    personal.category = category;
    personal.trashFiles = trashFiles;
    if (changed) {
      personalListKey = key;
      get<HTMLInputElement>("#documentSearch")!.value = "";
      trash.close();
      if (category === "document" || (category === "trash" && !trashFiles)) files.close();
      else files.open(projectId, category === "trash" ? { state: "trashed" } : { state: "saved", kind: category });
      if (category === "trash" && !trashFiles)
        void trash.show(get<HTMLElement>("[data-personal-deleted-documents]")!).catch(report);
    }
    renderTree();
  }
  function closePersonal(restore = true) {
    if (!personal || editor.saving) return;
    selectionEpoch++;
    opening = false;
    editor.mount(get<HTMLElement>("#documentEditor")!);
    inlineAsset.close();
    setMessageHtml(get("[data-personal-asset] [data-asset-detail]"), "");
    renderTree();
    personal.showList(restore);
  }
  async function openPersonalAsset(
    asset: Pick<CreativeAsset, "id" | "title" | "project">,
    version?: string,
    fromList = false,
  ) {
    if (!personal || !workspaceReady || editor.saving || asset.project !== projectId) return;
    const generation = epoch,
      selection = ++selectionEpoch;
    opening = false;
    editor.mount(get<HTMLElement>("#documentEditor")!);
    directory.set(false);
    personal.read("asset", asset.id, asset.title, fromList);
    const title = get<HTMLElement>("[data-personal-reader-title]")!;
    personalAddress("", asset.id, version, fromList);
    controls();
    title.focus({ preventScroll: true });
    const openedAsset = await inlineAsset.readInline(
      asset,
      get<HTMLElement>("[data-personal-asset] [data-asset-detail]")!,
      title,
      get<HTMLElement>("[data-personal-asset-commands]")!,
      async () => {
        if (generation !== epoch || selection !== selectionEpoch) return;
        closePersonal();
        personalAddress();
        await files.refresh();
      },
      version,
    );
    if (openedAsset && generation === epoch && selection === selectionEpoch && personal.category !== openedAsset.kind) {
      showPersonalCategory(openedAsset.kind);
      personalAddress("", asset.id, version);
    }
  }
  async function syncPersonalRoute(documentId = "") {
    const url = personalLocation();
    if (!personal || !url || !workspaceReady || editor.saving) return;
    const key = personalRouteKey(url);
    if (key === personalKey) return;
    personalKey = key;
    const asset = url.searchParams.get("asset");
    const category = documentId ? "document" : personalCategory(url.searchParams.get("category"));
    showPersonalCategory(category);
    if (documentId) {
      if (!index.byId.has(documentId)) {
        report(new DocumentApiError(404, { messageId: "documents.unavailable" }));
        return;
      }
      await select(documentId, url.searchParams.get("edit") === "1");
    } else if (asset) {
      await openPersonalAsset(
        { id: asset, project: "personal", title: t("creative.file") },
        url.searchParams.get("assetVersion") || undefined,
      );
    } else closePersonal(true);
  }
  async function completed(result: DocumentTreeMutation, kind: string) {
    if (sourceView || result.tree.projectId !== projectId) return;
    index = new DocumentTreeIndex(session.snapshot);
    if (kind === "create" || kind === "create-template" || kind === "restore") {
      await select(result.operation.documentId, kind !== "restore");
      if (result.operation.restoredToRoot) {
        notice(t("documents.restoredToRoot"));
        localizeText(get("#documentNotice"), "documents.restoredToRoot", undefined, t);
      }
      return;
    }
    if (kind === "trash" && result.operation.affectedDocumentIds.includes(editor.id)) {
      if (personal) closePersonal();
      else editor.mount(get<HTMLElement>("#documentEditor")!);
      address("");
    }
    if (kind === "rename") {
      const record = index.byId.get(result.operation.documentId)?.document;
      if (record && editor.id === record.id) editor.acceptRename(record);
    }
    if (kind === "move") view.reveal(index, result.operation.documentId);
    renderTree();
  }
  async function execute(operation: () => Promise<unknown>) {
    const generation = epoch;
    notice("");
    try {
      await operation();
    } catch (error) {
      if (generation !== epoch || sourceView) return;
      report(error);
      if (error instanceof DocumentApiError && error.status === 409) await session.refresh().catch(report);
    }
  }
  async function createFromTemplate(parentId: string | null) {
    if (!fileMode || session.busy || session.pending) return;
    const generation = epoch;
    directory.set(false);
    const result = await templatePicker.open(parentId, async (intent) => {
      try {
        return await session.mutate(intent);
      } catch (error) {
        if (session.pending) templatePicker.close();
        throw error;
      }
    });
    if (result && generation === epoch) await completed(result, "create-template");
  }
  function clear() {
    epoch++;
    selectionEpoch++;
    capabilityRead?.abort();
    workspaceReady = false;
    opening = false;
    directoryScroll = 0;
    drag?.destroy();
    drag = null;
    menu.close();
    view.cancelSearch();
    directory.set(false);
    trash.close();
    templatePicker.close();
    creation.close();
    files.close();
    inlineAsset.close();
    personal = null;
    personalKey = "";
    personalListKey = "";
    knowledge.close();
    recordView.close();
    lastKnowledge = "";
    session.close();
    editor.detach();
    dialogs.close();
    document.body.classList.remove("document-focus-editing", "project-creation-reading");
    root.classList.remove("document-open", "is-editing", "personal-content-open");
  }
  function enterSources() {
    clear();
    sourceView = true;
    focusDocument(false);
    root.classList.remove("project-document-authoring");
    const url = new URL(location.href);
    url.searchParams.set("view", "sources");
    url.searchParams.delete("document");
    history.replaceState(history.state, "", url);
    setMessageHtml(
      root,
      `<div class="document-sources-back">${button(t, "documents.backToDocuments", "back")}</div><div id="authoringConnectedSources"></div>`,
    );
    options.sources.show(get<HTMLElement>("#authoringConnectedSources")!, projectId);
  }
  async function load(project: string, documentId = "", query = "") {
    clear();
    options.sources.hide();
    sourceView = false;
    fileMode = false;
    root.classList.add("project-document-authoring");
    projectId = project;
    lastRequested = documentId;
    focusDocument(root.isConnected && !embedded);
    const generation = epoch;
    const capabilityController = new AbortController();
    capabilityRead = capabilityController;
    root.classList.toggle("project-creation-documents", embedded);
    setMessageHtml(root, authoringFrame(t, project, embedded ? options.projectFrame?.(project) : ""));

    root.classList.toggle("personal-creation-library", project === "personal");
    if (project === "personal") {
      personal = new PersonalCreationLibrary(root, t, options.identityKey);
      personal.update();
      get("[data-personal-files]")!.append(files.element);
      get<HTMLButtonElement>("[data-personal-import]")!.onclick = () => void files.importFile();
      get<HTMLButtonElement>("[data-personal-toggle-view]")!.onclick = () => {
        personal?.toggleView();
        renderTree();
      };
    }
    header.mount();
    setMessageHtml(get("#documentEditor"), empty(t, "documents.loading"));
    view.open(project);
    view.query = query;
    session.open(project);
    get<HTMLInputElement>("#documentSearch")!.value = query;
    get<HTMLInputElement>("#documentSearch")!.oninput = () => {
      view.search(get<HTMLInputElement>("#documentSearch")!.value, renderTree);
      files.search(get<HTMLInputElement>("#documentSearch")!.value);
      menu.close();
      drag?.cancel();
    };
    if (!personal)
      drag = new DocumentTreeDrag(
        get<HTMLElement>("#documentTree")!,
        () => index,
        () => !session.busy && !session.loading && !session.pending && !opening,
        (id) => {
          view.expand(id);
          renderTree();
        },
        (id, target) => void execute(() => actions.move(id, target)),
      );
    try {
      const [capabilities] = await Promise.all([
        documentJson<{ storage: "files" | "legacy"; websiteConfiguration?: boolean }>(
          "/api/project-documents/capabilities?" + new URLSearchParams({ project }),
          "GET",
          undefined,
          capabilityController.signal,
        ),
        session.refresh(),
      ]);
      if (generation !== epoch) return;
      fileMode = capabilities.storage === "files";
      if (!fileMode && new URL(location.href).searchParams.get("view") === "sources") {
        enterSources();
        return;
      }
      editor = fileMode
        ? new FileDocumentEditor(
            t,
            options.identityKey,
            project,
            modal,
            dialogs,
            onSaved,
            report,
            controls,
            capabilities.websiteConfiguration ? options.publishing : undefined,
            personal
              ? {
                  commands: get<HTMLElement>("[data-personal-doc-commands]")!,
                  title: get<HTMLElement>("[data-personal-reader-title]")!,
                }
              : undefined,
          )
        : legacyEditor();
      editor.mount(get<HTMLElement>("#documentEditor")!);
      workspaceReady = true;
      if (fileMode) {
        root.querySelector('[data-authoring-action="sources"]')?.remove();
        if (!personal) {
          files.open(project);
          get("#documentTree")!.append(files.element);
        }
      }
      if (personal) {
        await syncPersonalRoute(documentId);
        controls();
        return;
      }
      const selected =
        documentId ||
        (!embedded && index.byId.has(view.selected) ? view.selected : "") ||
        (!embedded ? index.children.get(null)?.[0]?.documentId : "") ||
        "";
      if (selected) {
        if (!index.byId.has(selected)) throw new DocumentApiError(404, { messageId: "documents.unavailable" });
        const edit = new URL(location.href).searchParams.get("edit") === "1";
        if (edit) {
          const url = new URL(location.href);
          url.searchParams.delete("edit");
          history.replaceState(history.state, "", url);
        }
        await select(selected, edit);
      } else {
        showDocumentWelcome();
        controls();
      }
    } catch (error) {
      if (generation !== epoch) return;
      const failure = `<div class="project-document-load-error">${empty(t, "documents.unavailable")}${button(t, "common.retry", "reload-workspace")}</div>`;
      setMessageHtml(get(personal ? "[data-personal-documents]" : "#documentEditor"), failure);
      if (!personal && !index.tree.nodes.length)
        setMessageHtml(get("#documentTree"), empty(t, "documents.unavailable"));
      report(error);
      controls();
    }
  }
  function showDocumentWelcome() {
    const host = get("#documentEditor");
    if (!embedded) {
      setMessageHtml(host, empty(t, "documents.authoringEmpty", "documents.authoringEmptyHint"));
      return;
    }
    const recent = [...index.tree.nodes].sort((a, b) => b.document.updatedAt - a.document.updatedAt).slice(0, 8);
    if (!recent.length) {
      setMessageHtml(
        host,
        `<section class="project-document-welcome project-document-empty">${empty(t, "documents.noDocuments", "projects.createFirstDocumentHint")}${button(t, "documents.newDocument", "new", "", true, "plus")}</section>`,
      );
      return;
    }
    const { format } = getBrowserI18n();
    const rows = recent
      .map(({ documentId, document }) => {
        const date = new Date(document.updatedAt);
        return `<li><button type="button" class="project-recent-document" data-project-recent="${e(documentId)}">${codexIcon("file")}<span data-i18n-ignore>${e(document.title)}</span>${Number.isFinite(date.getTime()) ? `<time datetime="${date.toISOString()}" data-i18n-ignore>${e(format.dateTime(date, { dateStyle: "medium" }))}</time>` : ""}${codexIcon("chevronRight")}</button></li>`;
      })
      .join("");
    setMessageHtml(
      host,
      `<section class="project-document-welcome" aria-labelledby="projectRecentDocuments"><header><h2 id="projectRecentDocuments">${messageHtml("projects.recentDocuments", {}, t)}</h2><span>${messageHtml("projects.updated", {}, t)}</span></header><ul class="project-document-recent">${rows}</ul></section>`,
    );
  }
  function closeProjectDocument() {
    if (opening || editor.saving) return;
    const previous = editor.id;
    editor.mount(get<HTMLElement>("#documentEditor")!);
    address("");
    showDocumentWelcome();
    renderTree();
    const row = get<HTMLButtonElement>(`.document-tree-title[data-id="${CSS.escape(previous)}"]`);
    root.closest(".workbench-view")?.scrollTo(0, directoryScroll);
    (row || get<HTMLInputElement>("#documentSearch"))?.focus({ preventScroll: true });
  }
  async function act(action: string) {
    if (action === "close-project-document" && embedded) return closeProjectDocument();
    if (action === "reload-workspace") return load(projectId, lastRequested, view.query);
    if (action === "close-content" && personal) {
      closePersonal();
      personalAddress();
      return;
    }
    if (action === "copy-content" && personal && editor.record) {
      if (await copyPersonalDocument(modal, t, editor.record, options.projects?.() ?? []))
        notice(t("creative.copyDone"));
      return;
    }
    if (action === "knowledge") {
      if (!fileMode || !workspaceReady) return;
      directory.set(false);
      await knowledge.open({
        project: projectId,
        documents: index.tree.nodes.map((node) => ({ id: node.documentId, title: index.path(node.documentId) })),
        selected: editor.id ? [editor.id] : [],
      });
      return;
    }
    if (["new-ai", "ai-tasks"].includes(action)) {
      if (!fileMode || session.busy || session.loading || session.pending) return;
      directory.set(false);
      const generation = epoch;
      await creation.open({
        projectId,
        parentId: null,
        treeVersion: () => session.snapshot.version,
        locations: [
          { id: null, label: t("creation.rootLocation") },
          ...index.tree.nodes.map((node) => ({ id: node.documentId, label: index.path(node.documentId) })),
        ],
        history: action === "ai-tasks",
        async open(id) {
          if (generation !== epoch) return;
          await session.refresh();
          if (generation === epoch) await select(id);
        },
        async openArtifact(artifact) {
          if (generation === epoch) {
            if (personal) {
              showPersonalCategory(artifact.kind);
              await openPersonalAsset(
                { id: artifact.assetId, title: artifact.title, project: artifact.projectId },
                artifact.version,
              );
            } else await files.follow(artifact.projectId, artifact.assetId, artifact.version);
          }
        },
        manual: (parentId) => execute(() => actions.create(parentId)),
      });
      return;
    }
    if (action === "reader-edit") {
      directory.set(false);
      editor.beginEditing();
      return;
    }
    if (["directory", "reader-directory"].includes(action)) {
      menu.close();
      const more = get<HTMLDetailsElement>(".document-editor-more");
      if (more) more.open = false;
      directory.toggle();
      return;
    }
    if (["directory-close", "directory-dismiss"].includes(action)) {
      menu.close();
      directory.set(false, true);
      return;
    }
    if (action === "back") {
      const url = new URL(location.href);
      url.searchParams.delete("view");
      history.replaceState(history.state, "", url);
      await load(projectId, lastRequested);
      return;
    }
    if (action === "sources") {
      enterSources();
      return;
    }
    if (action === "refresh-tree") {
      menu.close();
      drag?.cancel();
      void files.refresh();
      await session.refresh();
      if (embedded && get(".project-document-welcome")) showDocumentWelcome();
      return;
    }
    if (action === "retry-tree") {
      const kind = session.pending?.intent.kind,
        result = await session.retry();
      if (result) await completed(result, kind || "");
      return;
    }
    if (action === "new-template") return createFromTemplate(null);
    if (["new", "directory-new", "new-child", "directory-child"].includes(action)) {
      const add = get<HTMLDetailsElement>(".authoring-directory-add");
      if (add) add.open = false;
      directory.set(false);
      await actions.create(["new-child", "directory-child"].includes(action) ? editor.id : null);
      return;
    }
    if (action === "move-document") return actions.run("move", editor.id);
    if (action === "trash-document") return actions.run("trash", editor.id);
    if (action === "trash") {
      directory.set(false);
      if (personal) {
        if (editor.saving) return;
        closePersonal(false);
        showPersonalCategory("trash");
        personalAddress();
        personal.focusList();
        return;
      }
      editor.mount(get<HTMLElement>("#documentEditor")!);
      address("");
      controls();
      await trash.show(get<HTMLElement>("#documentEditor")!);
      if (embedded && directory.mobile.matches) get(".document-trash")?.scrollIntoView({ block: "start" });
    }
  }
  root.addEventListener("click", (event) => {
    const recent = (event.target as Element).closest<HTMLButtonElement>("[data-project-recent]");
    if (recent?.dataset.projectRecent && !opening && !editor.saving) {
      void execute(() => select(recent.dataset.projectRecent!));
      return;
    }
    const item = (event.target as Element).closest<HTMLButtonElement>(
      "[data-personal-document],[data-personal-category],[data-personal-trash]",
    );
    if (personal && item && !item.disabled && !editor.saving) {
      const id = item.dataset.personalDocument;
      if (id) void execute(() => select(id, false, !!get("[data-personal-list]")?.contains(item)));
      else {
        closePersonal(false);
        directory.set(false);
        showPersonalCategory(
          personalCategory(item.dataset.personalCategory ?? "trash"),
          item.dataset.personalTrash === "files",
        );
        personalAddress();
        if (!item.dataset.personalTrash || directory.mobile.matches) personal.focusList();
      }
      return;
    }
    const trigger = (event.target as Element).closest<HTMLButtonElement>("[data-authoring-action],[data-tree-action]");
    if (!trigger || trigger.disabled) return;
    const action = trigger.dataset.treeAction,
      id = trigger.closest<HTMLElement>("[data-tree-id]")?.dataset.treeId;
    if (action) {
      if (action === "toggle" && id) {
        view.expand(id, !view.expanded.has(id));
        renderTree();
        return;
      }
      if (action === "root") {
        view.query = "";
        get<HTMLInputElement>("#documentSearch")!.value = "";
        files.search("");
        renderTree();
        return;
      }
      if (action === "select" && id) {
        void execute(() => select(id));
        return;
      }
      if (id && action === "menu") {
        menu.open(
          trigger,
          (kind) =>
            void execute(() => (kind === "new-child-template" ? createFromTemplate(id) : actions.run(kind, id))),
          canChange([id]),
          fileMode,
        );
        return;
      }
      if (id && action === "move") void execute(() => actions.run("move", id));
      return;
    }
    const more = trigger.closest<HTMLDetailsElement>(
      ".document-workspace-more,.creative-reader-more,.project-create-menu",
    );
    if (more) {
      more.open = false;
      if (more.matches(".creative-reader-more,.project-create-menu"))
        more.querySelector("summary")?.focus({ preventScroll: true });
    }
    void execute(() => act(trigger.dataset.authoringAction || ""));
  });
  root.addEventListener("keydown", (event) => {
    if (event.isComposing || !(event.target as Element).closest(".document-tree-title")) return;
    const row = (event.target as Element).closest<HTMLElement>("[data-tree-id]"),
      id = row?.dataset.treeId;
    if (!id) return;
    const rows = index.visible(view.expanded, view.query),
      at = rows.findIndex((entry) => entry.node.documentId === id);
    let next = "";
    if (event.key === "ArrowDown") next = rows[at + 1]?.node.documentId || id;
    if (event.key === "ArrowUp") next = rows[at - 1]?.node.documentId || id;
    if (event.key === "Home") next = rows[0]?.node.documentId || id;
    if (event.key === "End") next = rows.at(-1)?.node.documentId || id;
    if (event.key === "ArrowRight") {
      if (!view.expanded.has(id)) {
        view.expand(id);
        renderTree();
      } else next = index.children.get(id)?.[0]?.documentId || id;
    }
    if (event.key === "ArrowLeft") {
      if (view.expanded.has(id)) {
        view.expand(id, false);
        renderTree();
      } else next = index.byId.get(id)?.parentId || id;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key)) event.preventDefault();
    if (next)
      [...root.querySelectorAll<HTMLElement>("[data-tree-id]")]
        .find((node) => node.dataset.treeId === next)
        ?.querySelector<HTMLButtonElement>(".document-tree-title")
        ?.focus({ preventScroll: false });
  });
  window.addEventListener("pagehide", () => editor.flush());
  getBrowserI18n().subscribe(() => {
    if (personal && root.isConnected) renderTree();
    if (embedded && root.isConnected && get(".project-document-welcome")) showDocumentWelcome();
  });
  return {
    show(host: HTMLElement, project: string, documentId = "", knowledgeId = "", inProject = false) {
      if (root.parentElement === host && projectId === project && embedded === inProject) {
        if (embedded) {
          const details = options.projects?.().find((item) => item.id === project);
          if (details) updateProjectHeading(root, details.name);
          if (lastRequested !== documentId && !documentId && editor.id) closeProjectDocument();
        }
        if (personal) void execute(() => syncPersonalRoute(documentId));
        else if (sourceView && (knowledgeId || documentId)) void load(project, documentId);
        else if (lastRequested !== documentId && documentId) {
          if (!workspaceReady || !index.byId.has(documentId)) void load(project, documentId);
          else void execute(() => select(documentId));
        }
      } else {
        embedded = inProject;
        host.replaceChildren(root);
        void load(project, documentId);
      }
      const requested = knowledgeId ? project + ":" + knowledgeId : "";
      if (lastKnowledge !== requested) {
        lastKnowledge = requested;
        recordView.close();
        if (knowledgeId) void recordView.open(project, knowledgeId);
      }
    },
    hide() {
      clear();
      options.sources.hide();
      root.remove();
      focusDocument(false);
    },
  };
}
