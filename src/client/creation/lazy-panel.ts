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
  constructor(
    private readonly t: Translate,
    private readonly identity: string,
  ) {}
  async open(context: CreationContext) {
    const epoch = ++this.epoch;
    const loaded = await runtime.load();
    if (epoch !== this.epoch) return;
    this.panel ??= new loaded.DocumentCreationPanel(this.t, this.identity);
    await this.panel.open(context);
  }
  close() {
    this.epoch++;
    this.panel?.close();
  }
}
