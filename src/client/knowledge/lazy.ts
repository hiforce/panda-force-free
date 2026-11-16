import type { Translate } from "../../shared/i18n/messages.js";
import type { KnowledgePanelContext } from "./views.js";
import { DocumentRuntimeLoader, RuntimeLoadError } from "../documents/runtime-loader.js";
import { isModuleNetworkError } from "../documents/module-network-error.js";
import { setMessageHtml } from "../i18n.js";
import { escapeHtml as e } from "../../shared/html.js";
import { codexIcon } from "../codex-icons.js";

type Runtime = typeof import("./runtime.js");
const runtime = new DocumentRuntimeLoader<Runtime>({
  prime: async () => {},
  isTransferFailure: isModuleNetworkError,
  evaluate: (entry) => (entry ? import("/knowledge.bundle.js?retry=1") : import("/knowledge.bundle.js")),
});

/** A visible, closable loading state owns late imports; leaving never opens a hidden knowledge dialog. */
class LazyKnowledgeView<Args extends unknown[]> {
  private epoch = 0;
  private view: { open(...args: Args): Promise<void>; close(): void } | null = null;
  private dialog: HTMLDialogElement | null = null;
  private previous: Element | null = null;
  constructor(
    private readonly t: Translate,
    private readonly create: (module: Runtime) => NonNullable<LazyKnowledgeView<Args>["view"]>,
    private readonly dismissed: () => void = () => {},
    private readonly title: "knowledge.title" | "knowledge.recordTitle" = "knowledge.title",
  ) {}
  close() {
    this.epoch++;
    this.view?.close();
    this.hideLoading();
  }
  private hideLoading() {
    if (!this.dialog?.open) return;
    this.dialog.close();
    this.dialog.replaceChildren();
    if (this.previous instanceof HTMLElement && this.previous.isConnected) this.previous.focus({ preventScroll: true });
  }
  private loading() {
    if (!this.dialog) {
      this.dialog = document.createElement("dialog");
      this.dialog.className = "workbench-dialog knowledge-panel";
      this.dialog.setAttribute("aria-label", this.t(this.title));
      document.body.append(this.dialog);
      const dismiss = () => {
        this.close();
        this.dismissed();
      };
      this.dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dismiss();
      });
      this.dialog.onclick = (event) => {
        if ((event.target as Element).closest("[data-knowledge-close]")) dismiss();
      };
    }
    setMessageHtml(
      this.dialog,
      `<header class="knowledge-heading"><h2>${e(this.t(this.title))}</h2><button type="button" class="wb-button" data-knowledge-close aria-label="${e(this.t("knowledge.close"))}">${codexIcon("x")}</button></header><div class="knowledge-scroll" data-knowledge-loading><p role="status">${e(this.t("knowledge.loading"))}</p></div>`,
    );
    this.dialog.showModal();
  }
  async open(...args: Args) {
    this.close();
    const epoch = this.epoch;
    this.previous = document.activeElement;
    if (!this.view) this.loading();
    try {
      if (!this.view) {
        const module = await runtime.load();
        if (epoch !== this.epoch) return;
        this.hideLoading();
        this.view = this.create(module);
      }
      await this.view.open(...args);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.view?.close();
      if (!this.dialog?.open) this.loading();
      const retryable = error instanceof RuntimeLoadError && error.retryable,
        target = this.dialog!.querySelector<HTMLElement>("[data-knowledge-loading]")!;
      setMessageHtml(
        target,
        `<p role="status">${e(this.t("knowledge.unavailable"))}</p><button type="button" class="wb-button">${e(this.t(retryable ? "common.retry" : "common.reloadWorkspace"))}</button>`,
      );
      target.querySelector<HTMLButtonElement>("button")!.onclick = () =>
        retryable ? void this.open(...args) : location.reload();
    }
  }
}

export class KnowledgePanel extends LazyKnowledgeView<[KnowledgePanelContext]> {
  constructor(t: Translate, identity: string) {
    super(t, (module) => new module.KnowledgePanel(t, identity));
  }
}
export class KnowledgeRecordView extends LazyKnowledgeView<[string, string]> {
  constructor(t: Translate, dismissed: () => void) {
    super(t, (module) => new module.KnowledgeRecordView(t, dismissed), dismissed, "knowledge.recordTitle");
  }
}
