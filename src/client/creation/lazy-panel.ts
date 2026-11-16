import { setMessageHtml } from "../i18n.js";
import { creationLoadingFrame } from "./views.js";
import { isModuleNetworkError } from "../documents/module-network-error.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { CreationContext, DocumentCreationPanel } from "./controller.js";
import { DocumentRuntimeLoader } from "../documents/runtime-loader.js";
import { prepareDocumentModule } from "../documents/module-transfer.js";
const runtime = new DocumentRuntimeLoader({
  isTransferFailure: isModuleNetworkError,
  prime: (entry) =>
    prepareDocumentModule(entry ? "/document-creation.bundle.js?retry=1" : "/document-creation.bundle.js"),
  evaluate: (entry) =>
    entry ? import("/document-creation.bundle.js?retry=1") : import("/document-creation.bundle.js"),
});
/** Creation dialogs are optional application code; navigation invalidates a pending open before it can mount. */
export class LazyDocumentCreationPanel {
  private panel: DocumentCreationPanel | null = null;
  private epoch = 0;
  private cancelPreparation?: () => void;
  private readonly frame = document.createElement("dialog");
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
  ) {}
  prepare(cancel?: () => void) {
    this.panel?.close();
    this.cancelPreparation = cancel;
    const epoch = ++this.epoch;
    this.frame.className = "creation-dialog";
    setMessageHtml(this.frame, creationLoadingFrame(this.t));
    if (!this.frame.isConnected) document.body.append(this.frame);
    this.frame.onclick = (event) => {
      if ((event.target as Element).closest("[data-creation-close]")) this.close();
    };
    this.frame.oncancel = (event) => {
      event.preventDefault();
      this.close();
    };
    if (!this.frame.open) this.frame.showModal();
    return () => epoch === this.epoch && this.frame.open;
  }
  async open(context: CreationContext) {
    const epoch = ++this.epoch;
    if (!this.panel) {
      this.frame.className = "creation-dialog";
      setMessageHtml(this.frame, creationLoadingFrame(this.t));
      if (!this.frame.isConnected) document.body.append(this.frame);
      this.frame.onclick = (event) => {
        if ((event.target as Element).closest("[data-creation-close]")) this.close();
      };
      this.frame.oncancel = (event) => {
        event.preventDefault();
        this.close();
      };
      if (!this.frame.open) this.frame.showModal();
    }
    try {
      const loaded = await runtime.load();
      if (epoch !== this.epoch) return;
      this.cancelPreparation = undefined;
      this.frame.onclick = null;
      this.frame.oncancel = null;
      this.panel ??= new loaded.DocumentCreationPanel(this.t, this.identity, this.frame);
      await this.panel.open(context);
    } catch (error) {
      if (epoch === this.epoch) {
        this.frame.close();
        this.frame.remove();
      }
      throw error;
    }
  }
  close() {
    this.cancelPreparation?.();
    this.cancelPreparation = undefined;
    this.epoch++;
    this.panel?.close();
    if (!this.panel) {
      this.frame.close();
      this.frame.remove();
    }
  }
}
