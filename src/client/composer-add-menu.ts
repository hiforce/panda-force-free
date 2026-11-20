import { syncComposerPanelViewport } from "./session-controls/menu.js";
import { codexIcon } from "./codex-icons.js";
import { setMessageHtml, localizeAttribute, localizeText } from "./i18n.js";
import { escapeHtml as e } from "../shared/html.js";
import type { Translate } from "../shared/i18n/messages.js";
import { fileDocumentApi } from "./documents/files/api.js";
import type { SavedSourcePage } from "../shared/content-sources/catalog.js";
import { documentJson, documentApi } from "./documents/api.js";
import type { DocumentPage, DocumentRecord, DocumentSpace } from "../shared/documents/contracts.js";

interface AddMenuOptions {
  trigger: HTMLButtonElement;
  skills?: HTMLElement;
  input: HTMLInputElement;
  t: Translate;
  project?: () => string;
  attach: (name: string, load: () => Promise<File>) => void;
  projects?: {
    load(signal: AbortSignal): Promise<{ id: string; name: string }[]>;
    select(id: string): void;
  };
}

/** One material entry owns the top layer; asynchronous attachments keep their original draft identity. */
export function createComposerAddMenu({
  trigger,
  skills,
  input,
  t,
  project: projectSource,
  attach,
  projects,
}: AddMenuOptions) {
  const project = projectSource ?? (() => "");
  const dialog = document.createElement("dialog");
  dialog.className = "workbench-dialog composer-add-menu composer-panel";
  const titleId = "composer-add-" + crypto.randomUUID();
  dialog.setAttribute("aria-labelledby", titleId);
  setMessageHtml(
    dialog,
    `<header class="composer-panel-heading"><button type="button" class="composer-panel-action" data-add-back hidden data-pf-aria-label="common.back" aria-label="${e(t("common.back"))}">${codexIcon("arrowLeft")}</button><h2 tabindex="-1" id="${titleId}" data-pf-message="composer.addToMessage">${e(t("composer.addToMessage"))}</h2><button type="button" class="composer-panel-action" data-add-close data-pf-aria-label="common.close" aria-label="${e(t("common.close"))}">${codexIcon("x")}</button></header><div data-add-home><div class="composer-add-uploads">${(["camera", "photos", "files"] as const).map((kind) => `<button type="button" data-add-upload="${kind}">${codexIcon(kind === "camera" ? "camera" : kind === "photos" ? "image" : "file")}<span data-pf-message="composer.${kind}">${e(t(`composer.${kind}`))}</span></button>`).join("")}</div><div class="composer-add-sources"><div data-add-skills></div><button type="button" data-add-documents>${codexIcon("folderOpen")}<span><strong data-pf-message="composer.projectDocuments">${e(t("composer.projectDocuments"))}</strong><small data-pf-message="composer.documentSnapshotHint">${e(t("composer.documentSnapshotHint"))}</small></span>${codexIcon("chevronRight")}</button></div></div><section class="composer-add-documents" data-add-document-view hidden><div class="composer-add-document-filters wb-form"><label class="wb-field"><span data-pf-message="composer.documentSpace">${e(t("composer.documentSpace"))}</span><select data-add-space></select></label><label class="wb-field"><span class="sr-only" data-pf-message="composer.searchDocuments">${e(t("composer.searchDocuments"))}</span><input type="search" maxlength="200" data-add-search data-pf-placeholder="composer.searchDocuments" placeholder="${e(t("composer.searchDocuments"))}" autocomplete="off"></label></div><div class="composer-add-document-scroll" tabindex="0"><div data-add-document-list></div><p class="composer-add-status" role="status" data-add-status></p><button type="button" class="wb-button" data-add-more data-pf-message="composer.moreDocuments" hidden>${e(t("composer.moreDocuments"))}</button><button type="button" class="wb-button" data-add-retry data-pf-message="common.retry" hidden>${e(t("common.retry"))}</button></div></section>`,
  );
  if (skills) dialog.querySelector("[data-add-skills]")!.append(skills);
  else dialog.querySelector<HTMLElement>("[data-add-skills]")!.hidden = true;
  if (!projectSource) dialog.querySelector<HTMLElement>("[data-add-documents]")!.hidden = true;
  if (!skills && !projectSource) dialog.querySelector<HTMLElement>(".composer-add-sources")!.hidden = true;
  const home = dialog.querySelector<HTMLElement>("[data-add-home]")!,
    view = dialog.querySelector<HTMLElement>("[data-add-document-view]")!,
    back = dialog.querySelector<HTMLButtonElement>("[data-add-back]")!,
    heading = dialog.querySelector<HTMLElement>("h2")!,
    search = dialog.querySelector<HTMLInputElement>("[data-add-search]")!,
    space = dialog.querySelector<HTMLSelectElement>("[data-add-space]")!,
    list = dialog.querySelector<HTMLElement>("[data-add-document-list]")!,
    status = dialog.querySelector<HTMLElement>("[data-add-status]")!,
    more = dialog.querySelector<HTMLButtonElement>("[data-add-more]")!,
    retry = dialog.querySelector<HTMLButtonElement>("[data-add-retry]")!;
  const projectSelect = projects ? document.createElement("select") : null;
  if (projectSelect) {
    const field = document.createElement("label"),
      caption = document.createElement("span");
    field.className = "wb-field";
    localizeText(caption, "common.project", undefined, t);
    projectSelect.dataset.addProject = "";
    field.append(caption, projectSelect);
    dialog.querySelector(".composer-add-document-filters")!.prepend(field);
    projectSelect.onchange = () => {
      projects!.select(projectSelect.value);
      sourceReady = false;
      void showDocuments(false);
    };
  }
  let generation = 0,
    projectId = "",
    spaces: DocumentSpace[] = [],
    records: Pick<DocumentRecord, "id" | "title" | "path" | "revisionId">[] = [],
    offset: number | null = null;
  let sourceReady = false,
    fileMode = false,
    head: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let read: AbortController | null = null;
  function beginRead() {
    read?.abort();
    read = new AbortController();
    return AbortSignal.any([read.signal, AbortSignal.timeout(30000)]);
  }
  const viewport = () => syncComposerPanelViewport(dialog);
  function close(restore = true) {
    generation++;
    read?.abort();
    clearTimeout(timer);
    dialog.close();
    trigger.setAttribute("aria-expanded", "false");
    window.visualViewport?.removeEventListener("resize", viewport);
    window.visualViewport?.removeEventListener("scroll", viewport);
    window.removeEventListener("resize", viewport);
    if (restore) trigger.focus({ preventScroll: true });
  }
  function showHome() {
    generation++;
    read?.abort();
    clearTimeout(timer);
    home.hidden = false;
    view.hidden = true;
    back.hidden = true;
    localizeText(heading, "composer.addToMessage", undefined, t);
  }
  function loading() {
    localizeText(status, "composer.loadingDocuments", undefined, t);
    retry.hidden = true;
    more.hidden = true;
    list.setAttribute("aria-busy", "true");
  }
  async function load(reset = true) {
    const current = ++generation,
      signal = beginRead();
    loading();
    if (reset) {
      records = [];
      list.replaceChildren();
      offset = 0;
      head = undefined;
    }
    try {
      const page = fileMode
        ? await documentJson<SavedSourcePage>(
            "/api/content-sources?" +
              new URLSearchParams({
                project: projectId,
                contentKinds: "document",
                search: search.value.trim().slice(0, 200),
                offset: String(offset || 0),
                ...(head ? { head } : {}),
              }),
            "GET",
            undefined,
            signal,
          ).then((page) => ({
            documents: page.sources.map((row) => ({ ...row, revisionId: row.version })),
            nextOffset: page.nextOffset,
            head: page.head,
          }))
        : await documentJson<DocumentPage>(
            "/api/documents?" +
              new URLSearchParams({
                space: space.value,
                search: search.value.trim().slice(0, 200),
                offset: String(offset || 0),
              }),
            "GET",
            undefined,
            signal,
          );
      if (current !== generation || !dialog.open) return;
      records.push(...page.documents);
      offset = page.nextOffset;
      if ("head" in page) head = page.head;
      setMessageHtml(
        list,
        records
          .map(
            (record, index) =>
              `<button type="button" class="composer-add-document-row" data-add-document="${index}">${codexIcon("file")}<span><strong data-i18n-ignore>${e(record.title || record.path)}</strong><small data-i18n-ignore>${e(record.path)}</small></span>${codexIcon("plus")}</button>`,
          )
          .join(""),
      );
      if (records.length) setMessageHtml(status, "");
      else localizeText(status, "composer.noDocuments", undefined, t);
      more.hidden = offset === null;
    } catch {
      if (current !== generation || !dialog.open) return;
      localizeText(status, "composer.documentsFailed", undefined, t);
      retry.hidden = false;
    } finally {
      if (current === generation) list.setAttribute("aria-busy", "false");
    }
  }
  async function showDocuments(refreshProjects = true) {
    home.hidden = true;
    view.hidden = false;
    back.hidden = false;
    localizeText(heading, "composer.projectDocuments", undefined, t);
    if (projects && projectSelect && refreshProjects) {
      const current = ++generation,
        signal = beginRead();
      loading();
      list.replaceChildren();
      projectSelect.disabled = true;
      try {
        const entries = await projects.load(signal);
        if (current !== generation || !dialog.open) return;
        setMessageHtml(
          projectSelect,
          entries.map((entry) => `<option value="${e(entry.id)}" data-i18n-ignore>${e(entry.name)}</option>`).join(""),
        );
        if (!entries.some((entry) => entry.id === project())) projects.select(entries[0]?.id ?? "");
        projectSelect.value = project();
        projectSelect.disabled = !entries.length;
      } catch {
        if (current === generation && dialog.open) {
          sourceReady = false;
          localizeText(status, "composer.documentsFailed", undefined, t);
          retry.hidden = false;
        }
        return;
      }
    }
    if (project() && project() === projectId && sourceReady) {
      const scroll = dialog.querySelector<HTMLElement>(".composer-add-document-scroll")!,
        position = scroll.scrollTop;
      await load();
      if (dialog.open) scroll.scrollTop = position;
      return;
    }
    projectId = project();
    spaces = [];
    sourceReady = false;
    more.hidden = true;
    retry.hidden = true;
    search.value = "";
    space.replaceChildren();
    list.replaceChildren();
    space.disabled = true;
    search.disabled = true;
    if (!projectId) {
      localizeText(status, "composer.chooseDocumentProject", undefined, t);
      return;
    }
    const current = ++generation,
      signal = beginRead();
    loading();
    try {
      fileMode =
        (
          await documentJson<{ storage: "files" | "legacy" }>(
            "/api/project-documents/capabilities?" + new URLSearchParams({ project: projectId }),
            "GET",
            undefined,
            signal,
          )
        ).storage === "files";
      if (current !== generation || !dialog.open) return;
      space.closest<HTMLElement>("label")!.hidden = fileMode;
      if (fileMode) {
        sourceReady = true;
        search.disabled = false;
        await load();
        return;
      }
      const [published, library] = await Promise.all([
        documentJson<{ spaces: DocumentSpace[] }>(
          "/api/document-spaces?" + new URLSearchParams({ project: projectId }),
          "GET",
          undefined,
          signal,
        ),
        documentJson<{ library: DocumentSpace | null }>(
          "/api/project-documents?" + new URLSearchParams({ project: projectId }),
          "GET",
          undefined,
          signal,
        ),
      ]);
      spaces = [...(library.library ? [library.library] : []), ...published.spaces];
      if (current !== generation || !dialog.open) return;
      setMessageHtml(
        space,
        spaces
          .map(
            (entry) =>
              `<option value="${e(entry.id)}" ${entry.code === "__documents__" ? 'data-pf-message="composer.projectDocuments"' : "data-i18n-ignore"}>${e(entry.code === "__documents__" ? t("composer.projectDocuments") : entry.name)}</option>`,
          )
          .join(""),
      );
      sourceReady = true;
      space.disabled = !spaces.length;
      search.disabled = !spaces.length;
      if (spaces.length) await load();
      else localizeText(status, "composer.noDocuments", undefined, t);
    } catch {
      if (current !== generation || !dialog.open) return;
      localizeText(status, "composer.documentsFailed", undefined, t);
      retry.hidden = false;
    } finally {
      list.setAttribute("aria-busy", "false");
    }
  }
  search.oninput = () => {
    generation++;
    read?.abort();
    list.replaceChildren();
    loading();
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 200);
  };
  space.onchange = () => {
    clearTimeout(timer);
    void load();
  };
  more.onclick = () => void load(false);
  retry.onclick = () => void (sourceReady ? load() : showDocuments());
  dialog.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element;
      if (target.closest("[data-add-close]")) close();
      else if (target.closest("[data-add-back]")) {
        showHome();
        dialog.querySelector<HTMLButtonElement>("[data-add-documents]")!.focus();
      } else if (target.closest("[data-add-documents]")) void showDocuments();
      else if (target.closest("[data-composer-skill-trigger]")) close(false);
      else {
        const upload = target.closest<HTMLElement>("[data-add-upload]");
        if (upload) {
          close(false);
          input.accept = upload.dataset.addUpload === "files" ? "" : "image/*";
          input.multiple = upload.dataset.addUpload !== "camera";
          if (upload.dataset.addUpload === "camera") input.setAttribute("capture", "environment");
          else input.removeAttribute("capture");
          input.click();
        }
        const selected = target.closest<HTMLElement>("[data-add-document]");
        if (selected) {
          const record = records[Number(selected.dataset.addDocument)];
          if (!record || project() !== projectId) {
            close();
            return;
          }
          const name =
            (record.title || record.path)
              .replace(/[\p{Cc}\\/:*?"<>|]/gu, "_")
              .slice(0, 160)
              .replace(/\.md$/i, "") + ".md";
          // Reserve the original draft before reading a pinned revision or navigating away.
          const sourceProject = projectId,
            sourceFiles = fileMode;
          attach(name, async () => {
            try {
              const { revision } = await (sourceFiles
                ? fileDocumentApi(sourceProject, record.id).revision(record.revisionId)
                : documentApi.revision(record.id, record.revisionId));
              if (revision.documentId !== record.id || revision.id !== record.revisionId) throw new Error();
              return new File([revision.content], name, { type: "text/markdown" });
            } catch {
              throw new Error("composer.documentUnavailable");
            }
          });
          close();
        }
      }
    },
    true,
  );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && event.offsetX < 0) close();
  });
  document.body.append(dialog);
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  localizeAttribute(trigger, "title", "composer.addToMessage", undefined, t);
  localizeAttribute(trigger, "aria-label", "composer.addToMessage", undefined, t);
  trigger.onclick = () => {
    if (dialog.open) return;
    if (!dialog.isConnected) document.body.append(dialog);
    showHome();
    viewport();
    const touch = matchMedia("(pointer: coarse), (max-width: 767px)").matches;
    if (touch && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    heading.focus({ preventScroll: true });
    window.visualViewport?.addEventListener("resize", viewport);
    window.visualViewport?.addEventListener("scroll", viewport);
    window.addEventListener("resize", viewport);
  };
  return {
    close,
    dispose() {
      close(false);
      trigger.onclick = null;
      dialog.remove();
    },
  };
}
