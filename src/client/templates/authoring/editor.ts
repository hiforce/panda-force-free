import type { Translate } from "../../../shared/i18n/messages.js";
import type { TemplateDraftDetail } from "../../../shared/templates/authoring/contracts.js";
import { setMessageHtml, errorText } from "../../i18n.js";

import { PluginApiError } from "../../plugins/api.js";
import { DocumentApiError } from "../../documents/api.js";
import { DocumentModal } from "../../documents/modal.js";
import { DocumentDialogs } from "../../documents/dialogs.js";
import { RichDocumentSurface } from "../../documents/rich-surface.js";
import { TemplateAuthoringSession } from "./session.js";
import { templateRecoveries } from "./recovery.js";
import { templateAuthoringApi as api } from "./api.js";
import { fieldValue, readMetadata } from "./fields.js";
import { TemplateStructureFields } from "./structure.js";
import { templateEditorFrame } from "./views.js";
import { reviewTemplateVersion } from "./publish.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { TemplateCaptureQueue } from "./capture.js";

/** This view owns one editing surface; persistence and structured field state have their own lifetimes. */
export class DocumentTemplateEditor {
  private dialog = document.createElement("dialog");
  private modal: DocumentModal;
  private links: DocumentDialogs;
  private recovery: ReturnType<typeof templateRecoveries>;
  private session: TemplateAuthoringSession | null = null;
  private rich: RichDocumentSurface | null = null;
  private structure: TemplateStructureFields | null = null;
  private epoch = 0;
  private busy = false;
  private previous: HTMLElement | null = null;
  private captureQueue = new TemplateCaptureQueue(
    () => this.capture(),
    () => this.status(),
  );
  private leaving = () => {
    if (this.dialog.open) this.captureQueue.flush();
  };
  private visibility = () => {
    if (document.visibilityState === "hidden") this.leaving();
  };
  constructor(
    private t: Translate,
    identity: string,
    private changed: () => void,
  ) {
    this.dialog.id = "templateAuthoringEditor";
    this.dialog.className = "template-authoring-dialog";
    this.dialog.setAttribute("aria-labelledby", "templateAuthoringTitle");
    document.body.append(this.dialog);
    this.modal = new DocumentModal(t, "templateAuthoringForm");
    this.links = new DocumentDialogs(t, this.modal);
    this.recovery = templateRecoveries(identity);
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.onclick = (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-authoring-action]") : null;
      if (!button || button.disabled) return;
      const action = button.dataset.authoringAction;
      if (action === "close") return void this.close();
      if (action === "settings") return this.panel();
      void this.run(async () => {
        const session = this.session!;
        if (!this.captureQueue.flush()) return;
        if ((action === "save" || action === "publish") && !this.valid()) return;
        if (action === "save") await session.save();
        if (action === "publish") {
          if (session.changed || this.rich?.uploading) return;
          if (await reviewTemplateVersion(this.t, this.modal, session.saved.draft, this.changed))
            this.notice(this.t("templates.versionPublished"));
        }
        if (action === "reload") {
          const confirmed = await this.modal.form(
            this.t("templates.reloadSaved"),
            `<p>${e(this.t("templates.reloadSavedHint"))}</p>`,
            this.t("templates.reloadSaved"),
            async () => {
              await session.reload();
              return true;
            },
            { tone: "danger" },
          );
          if (confirmed && session === this.session) this.draw();
        }
      });
    };
  }
  open(detail: TemplateDraftDetail) {
    if (!this.close()) return;
    this.previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.session = new TemplateAuthoringSession(detail, api, this.recovery(detail.draft.id));
    this.draw();
    this.dialog.showModal();
    window.addEventListener("pagehide", this.leaving);
    document.addEventListener("visibilitychange", this.visibility);
  }
  close(force = false) {
    if (this.session) {
      if (!this.captureQueue.flush() && !force) return false;
      if (!this.session.persist() && this.session.changed && !force) {
        this.notice(this.t("templates.recoveryUnavailable"), true);
        return false;
      }
    }
    this.epoch++;
    this.captureQueue.clear();
    window.removeEventListener("pagehide", this.leaving);
    document.removeEventListener("visibilitychange", this.visibility);
    this.modal.close();
    this.structure?.destroy();
    this.structure = null;
    this.rich?.destroy();
    this.rich = null;
    this.session = null;
    this.busy = false;
    this.dialog.close();
    this.dialog.replaceChildren();
    if (this.previous?.isConnected) this.previous.focus({ preventScroll: true });
    this.previous = null;
    return true;
  }
  private get<T extends HTMLElement>(selector: string) {
    return this.dialog.querySelector<T>(selector)!;
  }
  private draw() {
    this.captureQueue.clear();
    const session = this.session!;
    this.structure?.destroy();
    this.rich?.destroy();
    setMessageHtml(this.dialog, templateEditorFrame(this.t, session.working));
    this.panel(window.matchMedia("(min-width:761px)").matches);
    const form = this.get<HTMLFormElement>("[data-authoring-form]");
    this.structure = new TemplateStructureFields(
      form,
      this.t,
      () => this.captureQueue.schedule(),
      (token) => {
        this.panel(false);
        void this.rich
          ?.insertMarkdown(token)
          .then(() => this.captureQueue.flush())
          .catch((error) => this.report(error));
      },
    );
    this.structure.mount(session.working);
    form.oninput = form.onchange = () => this.captureQueue.schedule();
    form.onsubmit = (event) => event.preventDefault();
    this.rich = new RichDocumentSurface(this.get("[data-authoring-editor]"), {
      body: session.working.body,
      content: "",
      toolbarHost: this.get("[data-authoring-toolbar]"),
      editable: true,
      t: this.t,
      imageUrl: (id) =>
        "/api/template-drafts/images/content?" + new URLSearchParams({ draft: session.saved.draft.id, id }),
      changed: () => this.captureQueue.schedule(),
      ready: () => this.status(),
      error: (error) => this.report(error),
      link: (current) => this.links.link(current),
      upload: async (file) => {
        const epoch = this.epoch,
          image = await api.image(session.saved.draft.id, file);
        if (epoch !== this.epoch || session !== this.session)
          throw new PluginApiError(409, { messageId: "templates.draftConflict" });
        session.update({
          ...session.working,
          images: [...session.working.images.filter((prior) => prior.id !== image.id), image],
        });
        session.persist();
        return {
          id: image.id,
          documentId: session.saved.draft.id,
          name: file.name,
          mime: image.mediaType,
          digest: image.sha256,
          size: image.bytes,
          width: image.width,
          height: image.height,
          alt: "",
          createdAt: Date.now(),
        };
      },
    });
    this.status();
  }
  private capture() {
    const session = this.session;
    if (!session || !this.dialog.querySelector("[data-authoring-form]")) return true;
    try {
      const definition = readMetadata(this.get("[data-authoring-form]"), session.working);
      session.update({
        ...definition,
        ...this.structure!.read(),
        instructions: fieldValue(this.dialog, "instructions"),
        body: this.rich?.snapshot().body || session.working.body,
      });
      session.persist();
      this.status();
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }
  private valid() {
    const form = this.get<HTMLFormElement>("[data-authoring-form]");
    if (form.checkValidity()) return true;
    this.panel(true);
    let parent = form.querySelector(":invalid")?.parentElement;
    while (parent && parent !== form) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
    form.reportValidity();
    return false;
  }
  private status() {
    const session = this.session;
    if (!session) return;
    this.get("[data-authoring-status]").textContent = this.t(
      session.recoveryFailed
        ? "templates.recoveryUnavailable"
        : session.conflict
          ? "templates.draftConflict"
          : session.pending && !session.busy && !this.busy
            ? "templates.saveUncertain"
            : this.busy || session.busy
              ? "documents.draftPending"
              : this.captureQueue.pending
                ? "templates.editingDraft"
                : session.dirty
                  ? "templates.savedInBrowser"
                  : "templates.draftSaved",
    );
    this.get("[data-authoring-generation]").textContent = this.t("documents.revision", {
      number: session.saved.draft.revision,
    });
    this.get("[data-authoring-conflict]").hidden = !session.conflict;
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>("[data-authoring-action]")) {
      const action = button.dataset.authoringAction;
      button.disabled =
        action === "close" || action === "settings"
          ? false
          : this.busy || session.busy || !!this.rich?.uploading || !this.rich?.ready;
      if (action === "save") {
        button.disabled ||= session.conflict || !(session.changed || this.captureQueue.pending);
        button.textContent = this.t(session.pending ? "templates.retrySave" : "templates.saveDraft");
      }
      if (action === "publish") button.disabled ||= session.changed || this.captureQueue.pending;
    }
    this.dialog.setAttribute("aria-busy", String(this.busy || session.busy));
  }
  private panel(force?: boolean) {
    const layout = this.get("[data-authoring-layout]"),
      open = force ?? layout.dataset.panel !== "true";
    layout.dataset.panel = String(open);
    this.get('[data-authoring-action="settings"]').setAttribute("aria-expanded", String(open));
  }
  private notice(text: string, failed = false) {
    const node = this.get("[data-authoring-notice]");
    if (!node) return;
    node.hidden = !text;
    node.textContent = text;
    node.dataset.error = String(failed);
  }
  private report(error: unknown) {
    this.notice(
      errorText(
        error instanceof PluginApiError || error instanceof DocumentApiError ? error.payload : null,
        this.t,
        "plugins.packageUnavailable",
      ),
      true,
    );
  }
  private async run(task: () => Promise<void>) {
    if (!this.session || this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    this.notice("");
    this.status();
    try {
      await task();
    } catch (error) {
      if (epoch === this.epoch) this.report(error);
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.status();
      }
    }
  }
}
