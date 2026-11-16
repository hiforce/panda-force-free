import type { Translate } from "../../shared/i18n/messages.js";
import type { DocumentDetail, DocumentRecord } from "../../shared/documents/contracts.js";
import { setMessageHtml, localizeText } from "../i18n.js";
import { documentApi, DocumentApiError } from "./api.js";
import {
  DocumentDrafts,
  revisionDraft,
  isDraftChanged,
  acknowledgeDocumentSave,
  type DocumentDraft,
} from "./drafts.js";
import { DocumentDialogs } from "./dialogs.js";
import { editor, empty, action } from "./views.js";
import type { DocumentResourceActions } from "./resources.js";
import { documentPreview } from "./preview.js";
import { RichDocumentSurface } from "./rich-surface.js";
import { documentResourcesApi } from "./api.js";
import type { DocumentPublicationActions } from "./action-port.js";
import { DocumentTitleLayout } from "./title-layout.js";
import type { DocumentEditorPort } from "./editor-port.js";
import { bindDocumentEditorHost } from "./editor-bindings.js";
export type { DocumentPublicationActions } from "./action-port.js";

/** Editing owns one revision base; asynchronous reads and writes cannot replace a newer selection. */
export class DocumentEditor implements DocumentEditorPort {
  private host: HTMLElement | null = null;
  private detail: DocumentDetail | null = null;
  private draft: DocumentDraft | null = null;
  private epoch = 0;
  private operation: "save" | "images" | null = null;
  private get busy() {
    return this.operation !== null;
  }
  private preview = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private rich: RichDocumentSurface | null = null;
  private saveFailures = 0;
  private renderEpoch = 0;
  private mountedListeners: AbortController | null = null;
  private titleLayout = new DocumentTitleLayout();
  constructor(
    private t: Translate,
    private drafts: DocumentDrafts,
    private dialogs: DocumentDialogs,
    private onSaved: (record: DocumentRecord) => void,
    private onError: (error: unknown) => void,
    private resources: DocumentResourceActions,
    private publishing: DocumentPublicationActions | null,
    private options: { authoring?: boolean; autosave?: boolean; stateChanged?(): void } = {},
  ) {}
  get id() {
    return this.detail?.document.id || "";
  }
  get record() {
    return this.detail?.document || null;
  }
  get changed() {
    return !!this.detail && !!this.draft && isDraftChanged(this.draft, this.detail);
  }
  get saving() {
    return this.busy || !!this.rich?.uploading;
  }
  get editing() {
    return !!this.draft?.body && !this.preview;
  }
  beginEditing() {
    this.showPreview(false, true);
  }
  /** A confirmed title-only application operation advances metadata without rebuilding the rich editor. */
  acceptRename(record: DocumentRecord) {
    if (
      !this.detail ||
      !this.draft ||
      this.id !== record.id ||
      this.changed ||
      this.saving ||
      record.contentHash !== this.detail.document.contentHash ||
      record.locale !== this.detail.document.locale ||
      record.revision < this.detail.document.revision
    )
      return false;
    this.detail = {
      ...this.detail,
      document: record,
      revision: {
        ...this.detail.revision,
        id: record.revisionId,
        number: record.revision,
        title: record.title,
        createdAt: record.updatedAt,
      },
    };
    this.draft = { ...this.draft, title: record.title, revision: record.revision };
    const title = this.host?.querySelector<HTMLInputElement | HTMLTextAreaElement>("#documentTitle");
    if (title) {
      title.value = record.title;
      this.titleLayout.resize();
    }
    const revision = this.host?.querySelector(".document-revision");
    if (revision) localizeText(revision, "documents.revision", { number: record.revision }, this.t);
    this.persist();
    this.status();
    return true;
  }
  mount(host: HTMLElement) {
    this.detach();
    this.host = host;
    this.mountedListeners = new AbortController();
    setMessageHtml(host, empty(this.t, "documents.selectDocument"));
    bindDocumentEditorHost(host, this.mountedListeners.signal, {
      capture: () => this.capture(),
      save: () => this.save(),
      focus: () => this.rich?.focus(),
      action: (name) => this.action(name),
      error: this.onError,
    });
  }
  detach() {
    this.publishing?.close();
    this.persist();
    this.titleLayout.close();
    this.mountedListeners?.abort();
    this.mountedListeners = null;
    this.epoch++;
    clearTimeout(this.autosaveTimer);
    this.renderEpoch++;
    this.rich?.destroy();
    this.rich = null;
    this.host = null;
    this.detail = null;
    this.draft = null;
    this.operation = null;
  }
  private persist() {
    clearTimeout(this.persistTimer);
    if (!this.detail || !this.draft) return;
    if (isDraftChanged(this.draft, this.detail)) this.drafts.write(this.id, { ...this.draft });
    else this.drafts.clear(this.id);
  }
  flush() {
    this.persist();
  }
  private capture() {
    if (!this.host || !this.draft) return;
    if (this.host.querySelector<HTMLTextAreaElement>("textarea#documentTitle")?.value !== this.titleLayout.value)
      this.titleLayout.resize();
    const rich = this.rich?.snapshot();
    this.draft = {
      ...this.draft,
      title: this.host.querySelector<HTMLInputElement | HTMLTextAreaElement>("#documentTitle")!.value,
      locale: this.host.querySelector<HTMLInputElement>("#documentLocale")!.value,
      ...(rich || { content: this.host.querySelector<HTMLTextAreaElement>("#documentSource")!.value }),
      updatedAt: Date.now(),
    };
    this.status();
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), 250);
    this.queueSave();
  }
  private queueSave() {
    clearTimeout(this.autosaveTimer);
    if (
      !this.options.autosave ||
      !this.detail ||
      !this.draft ||
      !isDraftChanged(this.draft, this.detail) ||
      this.rich?.uploading ||
      this.draft.revision !== this.detail.document.revision
    )
      return;
    this.autosaveTimer = setTimeout(
      () => void this.save().catch(this.onError),
      Math.max(1200, Math.min(30000, 1000 * 2 ** Math.min(this.saveFailures, 5))),
    );
  }
  async select(id: string, spaceId?: string) {
    this.publishing?.close();
    this.persist();
    const epoch = ++this.epoch;
    clearTimeout(this.autosaveTimer);
    this.rich?.destroy();
    this.rich = null;
    this.detail = null;
    this.draft = null;
    this.operation = null;
    if (this.host) setMessageHtml(this.host, empty(this.t, "documents.loading"));
    try {
      const detail = await documentApi.detail(id);
      if (epoch !== this.epoch || !this.host) return;
      if (spaceId && detail.document.spaceId !== spaceId)
        throw new DocumentApiError(404, { messageId: "documents.notFound" });
      this.install(detail);
    } catch (error) {
      if (epoch === this.epoch) {
        if (this.host) setMessageHtml(this.host, empty(this.t, "documents.notFound"));
        this.onError(error);
      }
    }
  }
  install(detail: DocumentDetail, edit = false) {
    this.persist();
    this.epoch++;
    clearTimeout(this.autosaveTimer);
    this.rich?.destroy();
    this.rich = null;
    this.saveFailures = 0;
    this.operation = null;
    this.detail = detail;
    const recovered = this.drafts.read(detail.document.id);
    this.draft = recovered && isDraftChanged(recovered, detail) ? recovered : revisionDraft(detail);
    if (!isDraftChanged(this.draft, detail)) this.drafts.clear(detail.document.id);
    this.preview = !!(this.options.authoring && !edit && this.draft.body);
    this.draw();
  }
  private draw() {
    if (!this.host || !this.detail || !this.draft) return;
    const render = ++this.renderEpoch;
    this.rich?.destroy();
    this.rich = null;
    this.titleLayout.close();
    setMessageHtml(
      this.host,
      editor(this.t, this.detail, this.draft, { publishing: !!this.publishing, authoring: this.options.authoring }),
    );
    if (this.draft.body) this.titleLayout.mount(this.host);
    if (this.draft.body) {
      try {
        this.mountRich(render);
      } catch (error) {
        this.onError(error);
      }
    }
    this.status();
    this.showPreview(this.preview);
  }
  private mountRich(render: number) {
    const epoch = this.epoch,
      host = this.host!,
      id = this.id;
    if (!this.draft?.body) return;
    this.rich = new RichDocumentSurface(host.querySelector<HTMLElement>("#documentRichEditor")!, {
      body: this.draft.body,
      content: this.draft.content,
      ready: () => {
        if (render !== this.renderEpoch || epoch !== this.epoch || host !== this.host) return;
        this.status();
        this.queueSave();
      },
      toolbarHost: host.querySelector<HTMLElement>("#documentToolbarSlot") || undefined,
      editable: !this.preview,
      t: this.t,
      changed: () => this.capture(),
      error: this.onError,
      upload: async (file) => (await documentResourcesApi.upload(id, file)).asset,
      link: (current) => this.dialogs.link(current),
    });
    this.status();
    this.queueSave();
  }
  private status() {
    if (!this.host || !this.detail || !this.draft) return;
    const readTitle = this.host.querySelector("#documentReadTitle");
    if (readTitle) readTitle.textContent = this.draft.title;
    const changed = isDraftChanged(this.draft, this.detail);
    localizeText(
      this.host.querySelector("#documentSaveState"),
      this.operation === "save"
        ? "documents.saving"
        : changed
          ? "documents.unsaved"
          : this.draft.body
            ? "documents.lastSaved"
            : "documents.saved",
      undefined,
      this.t,
    );
    this.options.stateChanged?.();
    const publish = this.host.querySelector<HTMLButtonElement>('[data-doc-action="publishing"]');
    const insert = this.host.querySelector<HTMLButtonElement>('[data-doc-action="insert-content"]');
    if (insert) insert.disabled = !this.rich?.ready || !this.editing;
    if (publish) {
      publish.disabled = this.saving || changed;
      publish.title = changed
        ? this.t("publishing.saveFirst")
        : this.t(this.draft.body ? "documents.publishDocument" : "publishing.open");
    }
    const language = this.host.querySelector<HTMLElement>("#documentLanguage");
    if (language) language.textContent = this.draft.locale;
    const importing = this.host.querySelector<HTMLButtonElement>('[data-doc-action="import-images"]');
    if (importing) {
      localizeText(
        importing,
        this.operation === "images" ? "documents.importingImages" : "documents.importImages",
        undefined,
        this.t,
      );
      importing.disabled = this.busy || changed;
      importing.title = this.t(changed ? "documents.saveBeforeImport" : "documents.importImageHint");
    }
    const save = this.host.querySelector<HTMLButtonElement>('[data-doc-action="save"]');
    if (save) {
      save.disabled =
        this.busy || !!this.rich?.uploading || !changed || this.draft.revision !== this.detail.document.revision;
      localizeText(save, this.operation === "save" ? "documents.saving" : "documents.save", undefined, this.t);
    }
    if (this.draft.revision !== this.detail.document.revision && !this.host.querySelector(".document-conflict")) {
      const notice = document.createElement("div");
      notice.className = "document-conflict";
      setMessageHtml(notice, `<p>${this.t("documents.conflict")}</p>${action(this.t, "documents.reload", "review")}`);
      this.host.prepend(notice);
    }
  }
  private showPreview(show: boolean, focus = false) {
    if (!this.host || !this.draft) return;
    this.preview = show;
    if (this.draft.body) {
      this.rich?.setEditable(!show);
      this.host.querySelector<HTMLInputElement | HTMLTextAreaElement>("#documentTitle")!.readOnly = show;
      this.host.classList.toggle("document-reading", show);
      this.host.classList.toggle("document-editing", !show);
      if (!show) this.titleLayout.resize();
      localizeText(
        this.host.querySelector("#documentModeLabel"),
        show ? "documents.readingMode" : "documents.editingMode",
        undefined,
        this.t,
      );
      localizeText(
        this.host.querySelector('[data-doc-action="preview"]'),
        show ? "documents.read" : "documents.doneEditing",
        undefined,
        this.t,
      );
      for (const name of ["edit", "preview"])
        this.host
          .querySelector(`[data-doc-action="${name}"]`)
          ?.setAttribute("aria-pressed", String((name === "preview") === show));
      if (focus && !show) this.rich?.focus();
      this.status();
      return;
    }
    const target = this.host.querySelector<HTMLElement>("#documentPreview")!;
    target.hidden = !show;
    this.host.querySelector<HTMLElement>("#documentSource")!.hidden = show;
    if (show)
      setMessageHtml(target, documentPreview(this.draft.content, this.detail?.engine, this.detail?.revision.resources));
    for (const name of ["edit", "preview"])
      this.host
        .querySelector(`[data-doc-action="${name}"]`)
        ?.setAttribute("aria-pressed", String((name === "preview") === show));
  }
  private async save(restoreRevisionId?: string) {
    if (this.busy || !this.detail || !this.draft) return;
    this.capture();
    if (this.rich?.uploading) return;
    if (!restoreRevisionId && !isDraftChanged(this.draft!, this.detail)) return;
    this.persist();
    const epoch = this.epoch,
      id = this.id,
      submitted = { ...this.draft! };
    this.operation = "save";
    this.status();
    try {
      const saved = await documentApi.save(id, { ...submitted, ...(restoreRevisionId ? { restoreRevisionId } : {}) });
      if (epoch !== this.epoch) return;
      this.detail = saved;
      this.saveFailures = 0;
      this.draft = acknowledgeDocumentSave(this.draft!, submitted, saved);
      const title = this.host?.querySelector<HTMLInputElement | HTMLTextAreaElement>("#documentTitle");
      if (title && title.value !== this.draft.title) {
        title.value = this.draft.title;
        this.titleLayout.resize();
      }
      const locale = this.host?.querySelector<HTMLInputElement>("#documentLocale");
      if (locale && locale.value !== this.draft.locale) locale.value = this.draft.locale;
      this.persist();
      this.onSaved(saved.document);
      const revision = this.host?.querySelector(".document-revision");
      if (revision) localizeText(revision, "documents.revision", { number: saved.document.revision }, this.t);
    } catch (reason) {
      if (epoch !== this.epoch) return;
      this.saveFailures++;
      if (reason instanceof DocumentApiError && reason.status === 409) {
        const latest = await documentApi.detail(id);
        if (epoch !== this.epoch) return;
        this.detail = latest;
      }
      this.onError(reason);
    } finally {
      if (epoch === this.epoch) {
        this.operation = null;
        this.status();
        this.queueSave();
      }
    }
  }
  private async importImages() {
    if (!this.detail || !this.draft || this.busy || isDraftChanged(this.draft, this.detail)) return;
    const epoch = this.epoch;
    this.operation = "images";
    this.status();
    try {
      const result = await documentApi.importImages(this.id, this.detail.document.revision);
      if (epoch !== this.epoch || !this.draft) return;
      this.detail = result.detail;
      // Edits typed while staging images remain a draft on the new resource revision.
      this.draft = { ...this.draft, revision: result.detail.document.revision };
      this.persist();
      this.onSaved(result.detail.document);
      const revision = this.host?.querySelector(".document-revision");
      if (revision) localizeText(revision, "documents.revision", { number: result.detail.document.revision }, this.t);
      this.showPreview(this.preview);
      await this.dialogs.importReport(result.imported, result.issues);
    } catch (error) {
      if (epoch === this.epoch) throw error;
    } finally {
      if (epoch === this.epoch) {
        this.operation = null;
        this.status();
      }
    }
  }
  private async action(name: string) {
    if (name === "insert-content" && this.rich && this.editing && this.host) {
      this.rich.openInsertMenu(this.host.querySelector<HTMLElement>('[data-doc-action="insert-content"]')!);
      return;
    }
    if (name === "edit" || name === "preview") {
      if (name === "preview" && this.draft?.body && this.host) {
        this.capture();
        const active = document.activeElement;
        if (active instanceof HTMLElement && this.host.contains(active)) active.blur();
      }
      this.showPreview(name === "preview", name === "edit");
      if (name === "preview" && this.options.autosave) void this.save().catch(this.onError);
      return;
    }
    if (name === "export" && this.draft && this.detail) {
      this.capture();
      const url = URL.createObjectURL(new Blob([this.draft.content], { type: "text/markdown;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = (this.draft.title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").trim() || "document") + ".md";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (name === "save") return this.save();
    if (name === "import-images") return this.importImages();
    if (!this.detail || this.busy) return;
    const epoch = this.epoch;
    if (name === "properties" && this.draft) {
      this.capture();
      const properties = await this.dialogs.properties(this.draft.locale);
      if (!properties || epoch !== this.epoch || !this.host) return;
      this.host.querySelector<HTMLInputElement>("#documentLocale")!.value = properties.locale;
      this.capture();
      return;
    }
    if (name === "publishing") {
      if (!this.publishing) return;
      if (this.draft && isDraftChanged(this.draft, this.detail)) return;
      const result = await this.publishing.open(this.detail.document, { richtext: !!this.draft?.body });
      if (result === null || epoch !== this.epoch || !this.draft) return;
      const base = result.kind === "markdown-draft" ? result.base : result.receipt.source;
      if (
        base.documentId !== this.id ||
        base.revisionId !== this.detail.document.revisionId ||
        base.sourceHash !== this.detail.document.contentHash ||
        base.version !== this.draft.revision ||
        isDraftChanged(this.draft, this.detail)
      )
        throw new DocumentApiError(409, { messageId: "documents.conflict" });
      if (result.kind === "source-applied") {
        if (result.receipt.applied.documentId !== this.id || result.receipt.applied.version <= base.version)
          throw new DocumentApiError(409, { messageId: "documents.conflict" });
        const fresh = await documentApi.detail(this.id);
        if (epoch !== this.epoch || !this.draft || !this.detail) return;
        if (isDraftChanged(this.draft, this.detail) || fresh.document.revision < result.receipt.applied.version)
          throw new DocumentApiError(409, { messageId: "documents.conflict" });
        const edit = !this.preview;
        this.install(fresh, edit);
        this.onSaved(fresh.document);
        this.host?.querySelector<HTMLButtonElement>('[data-doc-action="publishing"]')?.focus({ preventScroll: true });
        return;
      }
      if (this.draft.body) throw new DocumentApiError(400, { messageId: "documents.invalidRichBody" });
      this.draft = { ...this.draft, content: result.content, updatedAt: Date.now() };
      this.persist();
      this.draw();
      return;
    }
    if (name === "images") {
      const markdown = await this.resources.images(this.detail.document);
      if (!markdown || epoch !== this.epoch || !this.host) return;
      if (this.rich) {
        this.showPreview(false);
        await this.rich.insertMarkdown(markdown);
        return;
      }
      const source = this.host.querySelector<HTMLTextAreaElement>("#documentSource")!;
      source.setRangeText(markdown, source.selectionStart, source.selectionEnd, "end");
      this.capture();
      this.showPreview(false);
      source.focus();
      return;
    }
    if (name === "languages") {
      await this.resources.languages(this.detail.document);
      return;
    }
    if (name === "history") {
      const revision = await this.dialogs.history(this.detail);
      if (!revision || epoch !== this.epoch) return;
      this.draft = {
        revision: this.detail.document.revision,
        title: revision.title,
        locale: revision.locale,
        content: revision.content,
        ...(revision.body ? { body: revision.body } : {}),
        updatedAt: Date.now(),
      };
      this.persist();
      this.draw();
      // Restoration is a regular optimistic write, retaining the historical revision unchanged.
      await this.save(revision.id);
    } else if (name === "review") {
      const latest = await documentApi.detail(this.id);
      if (epoch !== this.epoch) return;
      const keepDraft = await this.dialogs.review(latest);
      if (!keepDraft || epoch !== this.epoch) return;
      this.detail = latest;
      this.draft = { ...this.draft!, revision: latest.document.revision };
      this.persist();
      this.draw();
    }
  }
}
