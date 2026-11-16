import type { Translate } from "../../../shared/i18n/messages.js";
import type { DocumentRecord } from "../../../shared/documents/contracts.js";
import { setMessageHtml, localizeText } from "../../i18n.js";
import { editor as editorView, empty, action } from "../views.js";
import { DocumentModal } from "../modal.js";
import { DocumentDialogs } from "../dialogs.js";
import { RichDocumentSurface } from "../rich-surface.js";
import { DocumentTitleLayout } from "../title-layout.js";
import { documentPreview } from "../preview.js";
import { FileEditorSession } from "./session.js";
import { fileRecovery } from "./recovery.js";
import { fileDocumentApi } from "./api.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { DocumentApiError } from "../api.js";
import { fileHistory } from "./history.js";
import type { DocumentPublicationActions } from "../action-port.js";
import type { DocumentEditorPort } from "../editor-port.js";
import { bindDocumentEditorHost } from "../editor-bindings.js";

/** This view owns one mounted document. Working generations, command receipts and source versions live in the session. */
export class FileDocumentEditor implements DocumentEditorPort {
  private host: HTMLElement | null = null;
  private session: FileEditorSession | null = null;
  private rich: RichDocumentSurface | null = null;
  private listeners: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private epoch = 0;
  private preview = true;
  private title = new DocumentTitleLayout();
  private failed = false;
  constructor(
    private t: Translate,
    private identity: string,
    private project: string,
    private modal: DocumentModal,
    private dialogs: DocumentDialogs,
    private saved: (record: DocumentRecord) => void,
    private error: (error: unknown) => void,
    private changedState: () => void,
    private publishing?: DocumentPublicationActions,
  ) {}
  get id() {
    return this.session?.snapshot.saved.document.id || "";
  }
  get record() {
    return this.session?.snapshot.saved.document || null;
  }
  get changed() {
    return (
      !!this.session && (this.session.dirty || this.session.unsent || this.session.uncertain || this.session.conflict)
    );
  }
  get saving() {
    return !!this.session?.busy || !!this.rich?.uploading;
  }
  get editing() {
    return !!this.session && !this.preview;
  }
  flush() {
    this.session?.persist();
  }
  mount(host: HTMLElement) {
    this.detach();
    this.host = host;
    this.listeners = new AbortController();
    bindDocumentEditorHost(host, this.listeners.signal, {
      capture: () => this.capture(),
      save: () => this.act("save"),
      focus: () => this.rich?.focus(),
      action: (name) => this.act(name),
      error: this.error,
    });
  }
  detach() {
    this.publishing?.close();
    try {
      this.flush();
    } catch (error) {
      this.error(error);
    }
    this.epoch++;
    clearTimeout(this.timer);
    this.listeners?.abort();
    this.listeners = null;
    this.rich?.destroy();
    this.rich = null;
    this.title.close();
    this.session = null;
    this.host = null;
  }
  async select(id: string) {
    this.publishing?.close();
    this.flush();
    clearTimeout(this.timer);
    const epoch = ++this.epoch;
    this.rich?.destroy();
    this.rich = null;
    this.session = null;
    if (this.host) setMessageHtml(this.host, empty(this.t, "documents.loading"));
    const session = await FileEditorSession.open(
      fileDocumentApi(this.project, id),
      fileRecovery(this.identity, this.project, id),
      () => {
        if (epoch === this.epoch) this.status();
      },
    );
    if (epoch !== this.epoch || !this.host) return;
    this.session = session;
    this.failed = false;
    this.preview = true;
    this.draw();
  }
  acceptRename(record: DocumentRecord) {
    if (record.id !== this.id || this.changed || this.saving) return false;
    void this.select(record.id).catch(this.error);
    return true;
  }
  beginEditing() {
    this.mode(false, true);
  }
  private capture() {
    if (!this.session || !this.host) return;
    const rich = this.rich?.snapshot();
    if (!this.session.uncertain && !this.session.conflict) this.failed = false;
    const title = this.host
      .querySelector<HTMLInputElement | HTMLTextAreaElement>("#documentTitle")!
      .value.replace(/[\r\n]+/g, " ");
    this.session.update({
      ...this.session.working,
      title,
      locale: this.host.querySelector<HTMLInputElement>("#documentLocale")!.value,
      ...(rich || { content: this.host.querySelector<HTMLTextAreaElement>("#documentSource")!.value }),
    });
    this.title.resize();
    this.queue();
  }
  private queue() {
    clearTimeout(this.timer);
    const session = this.session;
    if (
      !session ||
      !session.unsent ||
      !session.working.title.trim() ||
      session.conflict ||
      session.uncertain ||
      this.rich?.uploading ||
      this.failed
    )
      return;
    this.timer = setTimeout(() => void this.synchronize(session, false).catch(this.error), 1200);
  }
  private async synchronize(session: FileEditorSession, checkpoint: boolean) {
    if (session.busy || this.rich?.uploading) return;
    this.failed = false;
    try {
      await (checkpoint ? session.save() : session.autosave());
      if (session === this.session) {
        this.saved(session.snapshot.saved.document);
        this.status();
      }
    } catch (error) {
      if (session === this.session) {
        this.failed = true;
        this.status();
      }
      throw error;
    } finally {
      if (session === this.session) this.queue();
    }
  }
  private draw() {
    if (!this.host || !this.session) return;
    this.rich?.destroy();
    this.rich = null;
    this.title.close();
    const session = this.session,
      api = fileDocumentApi(this.project, this.id);
    setMessageHtml(
      this.host,
      editorView(this.t, session.snapshot.saved, session.working, { authoring: true, publishing: !!this.publishing }),
    );
    for (const name of ["images", "import-images", "languages"])
      this.host.querySelector(`[data-doc-action="${name}"]`)?.remove();
    this.host
      .querySelector(".document-rich-status span:last-child")
      ?.replaceChildren(document.createTextNode(this.t("documents.filePreviewHint")));
    this.host.dataset.fileEditor = "true";
    const footer = document.createElement("div");
    footer.className = "document-file-commands";
    setMessageHtml(
      footer,
      `${action(this.t, "documents.saveVersion", "save", "", true)}${action(this.t, "documents.retryChanges", "retry")}`,
    );
    this.host.querySelector(".document-editor-actions")!.prepend(footer);
    const conflict = document.createElement("aside");
    conflict.className = "document-conflict file-editor-conflict";
    conflict.hidden = true;
    conflict.setAttribute("role", "alert");
    setMessageHtml(
      conflict,
      `<p>${e(this.t("documents.localRecovery"))}</p>${action(this.t, "documents.discardWorking", "discard")}`,
    );
    this.host.querySelector(".document-canvas")!.prepend(conflict);
    if (session.working.body) {
      this.title.mount(this.host);
      this.rich = new RichDocumentSurface(this.host.querySelector<HTMLElement>("#documentRichEditor")!, {
        body: session.working.body,
        content: session.working.content,
        imageUrl: api.imageUrl,
        toolbarHost: this.host.querySelector<HTMLElement>("#documentToolbarSlot")!,
        editable: false,
        t: this.t,
        changed: () => {
          try {
            this.capture();
          } catch (error) {
            this.error(error);
          }
        },
        error: this.error,
        ready: () => this.status(),
        upload: api.upload,
        link: (current) => this.dialogs.link(current),
      });
    }
    this.mode(this.preview);
    this.status();
  }
  private mode(preview: boolean, focus = false) {
    if (!this.host || !this.session) return;
    this.preview = preview;
    const body = this.session.working.body;
    this.host.classList.toggle("document-reading", preview);
    this.host.classList.toggle("document-editing", !preview);
    this.host.querySelector<HTMLInputElement>("#documentTitle")!.readOnly = preview;
    this.rich?.setEditable(!preview);
    if (focus && !preview) this.rich?.focus();
    if (!body) {
      const target = this.host.querySelector<HTMLElement>("#documentPreview")!;
      target.hidden = !preview;
      this.host.querySelector<HTMLElement>("#documentSource")!.hidden = preview;
      if (preview)
        setMessageHtml(
          target,
          documentPreview(
            this.session.working.content,
            this.session.snapshot.saved.engine,
            this.session.working.resources,
            fileDocumentApi(this.project, this.id).imageUrl,
          ),
        );
    }
    localizeText(
      this.host.querySelector("#documentModeLabel"),
      preview ? "documents.readingMode" : "documents.editingMode",
      undefined,
      this.t,
    );
    localizeText(
      this.host.querySelector('[data-doc-action="preview"]'),
      preview ? "documents.read" : "documents.doneEditing",
      undefined,
      this.t,
    );
    this.status();
  }
  private status() {
    const s = this.session;
    if (!s || !this.host) return;
    const text = this.host.querySelector("#documentReadTitle");
    if (text) text.textContent = s.working.title;
    localizeText(
      this.host.querySelector("#documentSaveState"),
      this.failed
        ? "documents.draftFailed"
        : s.busy
          ? "documents.draftPending"
          : s.unsent
            ? "documents.unsaved"
            : s.dirty
              ? "documents.draftStored"
              : "documents.versionSaved",
      undefined,
      this.t,
    );
    localizeText(
      this.host.querySelector(".document-revision"),
      "documents.revision",
      { number: s.snapshot.saved.document.revision },
      this.t,
    );
    for (const button of this.host.querySelectorAll<HTMLButtonElement>('[data-doc-action="save"]')) {
      localizeText(button, "documents.saveVersion", undefined, this.t);
      button.disabled = this.saving || s.conflict || (!s.dirty && !s.uncertain);
    }
    const retry = this.host.querySelector<HTMLButtonElement>('[data-doc-action="retry"]')!;
    retry.hidden = !s.uncertain && !this.failed;
    retry.disabled = this.saving || s.conflict;
    this.host.querySelector<HTMLElement>(".document-conflict")!.hidden = !s.conflict;
    const insert = this.host.querySelector<HTMLButtonElement>('[data-doc-action="insert-content"]');
    if (insert) insert.disabled = !this.rich?.ready || !this.editing;
    const publish = this.host.querySelector<HTMLButtonElement>('[data-doc-action="publishing"]');
    if (publish) {
      publish.disabled = this.changed || this.saving;
      publish.title = this.t(this.changed ? "publishing.saveFirst" : "documents.publishDocument");
    }
    this.changedState();
  }
  private async act(name: string) {
    const s = this.session;
    if (!s) return;
    if (name === "publishing") {
      this.capture();
      if (!this.publishing || this.changed || this.saving) return;
      const result = await this.publishing.open(s.snapshot.saved.document, {
        richtext: true,
        scope: { projectId: this.project, storage: "files" },
      });
      if (this.session !== s || !result || result.kind !== "source-applied") return;
      const applied = result.receipt.applied;
      if (applied.documentId !== this.id || applied.projectId !== this.project) return;
      this.capture();
      if (this.changed || this.saving) return;
      await s.refreshSaved(applied.version);
      if (this.session !== s) return;
      this.saved(s.snapshot.saved.document);
      this.draw();
      return;
    }
    if (name === "edit") return this.beginEditing();
    if (name === "preview") {
      this.capture();
      this.mode(true);
      return;
    }
    if (name === "insert-content") {
      this.rich?.openInsertMenu(this.host!.querySelector<HTMLElement>('[data-doc-action="insert-content"]')!);
      return;
    }
    if (name === "save" || name === "retry") {
      this.capture();
      return this.synchronize(s, name === "save");
    }
    if (name === "properties") {
      const result = await this.dialogs.properties(s.working.locale);
      if (result && this.session === s) {
        this.host!.querySelector<HTMLInputElement>("#documentLocale")!.value = result.locale;
        this.capture();
      }
      return;
    }
    if (name === "discard") {
      if (this.saving) return;
      const confirm = await this.modal.form(
        this.t("documents.discardWorking"),
        `<p>${e(this.t("documents.discardWorkingHint"))}</p>`,
        this.t("documents.discardWorking"),
        async () => true,
        { tone: "danger" },
      );
      if (confirm && this.session === s) {
        await s.discard();
        this.failed = false;
        this.draw();
      }
      return;
    }
    if (name === "history") {
      if (this.saving) return;
      if (s.dirty || s.uncertain) {
        this.error(new DocumentApiError(409, { messageId: "documents.saveBeforeRestore" }));
        return;
      }
      const revision = await fileHistory(this.t, this.modal, fileDocumentApi(this.project, this.id));
      if (revision && this.session === s) {
        await s.restore(revision);
        this.saved(s.snapshot.saved.document);
        this.draw();
      }
      return;
    }
    if (name === "export") {
      const url = URL.createObjectURL(new Blob([s.working.content], { type: "text/markdown;charset=utf-8" })),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = (s.working.title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").trim() || "document") + ".md";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
