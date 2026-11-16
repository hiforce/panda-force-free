import type { RichEditorOptions, RichEditorPort, RichRuntimePort } from "./rich-port.js";
import { enhanceReadingCodeBlocks } from "./code-block/reading.js";
import { richDocumentReader } from "./rich-reader.js";
import { loadRichEditor } from "./rich-loader.js";
import { RuntimeLoadError } from "./runtime-loader.js";
import { localizeText } from "../i18n.js";

interface RichSurfaceOptions extends RichEditorOptions {
  content: string;
  ready(): void;
}

/** Source revisions stay in the controller; this view owns reader/writer lifetime and asynchronous readiness. */
export class RichDocumentSurface {
  private model: RichEditorPort | null = null;
  private readingCode: ReturnType<typeof enhanceReadingCodeBlocks> | null = null;
  private pending: Promise<RichEditorPort | null> | null = null;
  private disposed = false;
  private editable: boolean;
  private focusOrigin: Element | null = null;
  private banner: HTMLElement | null = null;
  private failure: RuntimeLoadError | null = null;
  constructor(
    private host: HTMLElement,
    private options: RichSurfaceOptions,
    private load: () => Promise<RichRuntimePort> = loadRichEditor,
  ) {
    this.editable = options.editable;
    this.renderReader();
    if (this.editable) void this.ensure();
  }
  private renderReader() {
    this.readingCode?.destroy();
    const shell = document.createElement("div");
    shell.className = "document-rich-shell";
    shell.append(
      richDocumentReader(this.options.body, this.options.t("documents.richEditorLabel"), this.options.imageUrl),
    );
    this.host.replaceChildren(shell);
    if (!this.editable) this.readingCode = enhanceReadingCodeBlocks(shell, this.options.t, this.options.error);
  }
  get ready() {
    return !!this.model;
  }
  get uploading() {
    return this.model?.uploading || false;
  }
  snapshot() {
    return this.model?.snapshot() || { body: this.options.body, content: this.options.content };
  }
  setEditable(value: boolean) {
    this.editable = value;
    this.model?.setEditable(value);
    if (!value) {
      this.focusOrigin = null;
      this.banner?.remove();
      this.banner = null;
      this.host.removeAttribute("aria-busy");
    } else if (!this.model) void this.ensure();
  }
  focus() {
    if (this.disposed || !this.editable) return;
    if (this.model) this.model.focus(false);
    else {
      this.focusOrigin = document.activeElement;
      void this.ensure();
    }
  }
  async insertMarkdown(markdown: string) {
    const model = await this.ensure();
    if (!this.disposed && this.editable) model?.insertMarkdown(markdown);
  }
  openInsertMenu(anchor: HTMLElement) {
    this.model?.openInsertMenu(anchor);
  }
  private notice(error?: RuntimeLoadError) {
    this.banner?.remove();
    const banner = document.createElement("div"),
      message = document.createElement("span");
    banner.className = "document-runtime-status";
    banner.setAttribute("role", error ? "alert" : "status");
    localizeText(
      message,
      !error
        ? "documents.loadingEditor"
        : error.phase === "initialization"
          ? error.retryable
            ? "documents.editorStillLoading"
            : "documents.editorStartFailed"
          : error.retryable
            ? "documents.editorLoadFailed"
            : "documents.editorLoadUnavailable",
      undefined,
      this.options.t,
    );
    banner.append(message);
    if (error?.retryable) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "wb-button";
      localizeText(retry, "common.retry", undefined, this.options.t);
      retry.onclick = () => {
        if (!this.disposed && this.editable) void this.ensure();
      };
      banner.append(retry);
    }
    this.host.prepend(banner);
    this.banner = banner;
  }
  private ensure(): Promise<RichEditorPort | null> {
    if (this.model) return Promise.resolve(this.model);
    if (this.disposed || !this.editable) return Promise.resolve(null);
    if (this.pending) {
      if (!this.banner) this.notice();
      this.host.setAttribute("aria-busy", "true");
      return this.pending;
    }
    if (this.failure && !this.failure.retryable) {
      this.notice(this.failure);
      return Promise.resolve(null);
    }
    this.failure = null;
    this.notice();
    this.host.setAttribute("aria-busy", "true");
    const pending = Promise.resolve()
      .then(() => this.load())
      .then((runtime) => {
        if (this.disposed || !this.editable) return null;
        const canvas = this.host.closest<HTMLElement>(".document-canvas"),
          top = canvas?.scrollTop,
          active = document.activeElement,
          focus =
            this.focusOrigin !== null &&
            (active === this.focusOrigin ||
              (active === document.body &&
                (!this.focusOrigin.isConnected || !this.focusOrigin.getClientRects().length)));
        this.readingCode?.destroy();
        this.readingCode = null;
        this.model = runtime.createRichDocumentEditor(this.host, {
          body: this.options.body,
          imageUrl: this.options.imageUrl,
          editable: true,
          toolbarHost: this.options.toolbarHost,
          t: this.options.t,
          changed: this.options.changed,
          error: this.options.error,
          upload: this.options.upload,
          link: this.options.link,
        });
        this.banner?.remove();
        this.banner = null;
        if (canvas && top !== undefined) canvas.scrollTop = top;
        if (focus) this.model.focus(false);
        this.focusOrigin = null;
        this.options.ready();
        return this.model;
      })
      .catch((cause) => {
        if (!this.disposed && this.editable) {
          if (!this.host.querySelector("[data-document-reader]")) this.renderReader();
          this.failure =
            cause instanceof RuntimeLoadError ? cause : new RuntimeLoadError("initialization", false, cause);
          this.notice(this.failure);
        }
        return null;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
        if (!this.disposed) this.host.removeAttribute("aria-busy");
      });
    this.pending = pending;
    return pending;
  }
  destroy() {
    this.disposed = true;
    this.focusOrigin = null;
    this.readingCode?.destroy();
    this.readingCode = null;
    this.model?.destroy();
    this.model = null;
    this.banner = null;
    this.host.removeAttribute("aria-busy");
    this.host.replaceChildren();
  }
}
