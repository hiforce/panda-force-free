import type { Translate } from "../../shared/i18n/messages.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import type { CreativeAssetsPanel } from "./assets-panel.js";
import { DocumentRuntimeLoader } from "../documents/runtime-loader.js";
import { prepareDocumentModule } from "../documents/module-transfer.js";
import { isModuleNetworkError } from "../documents/module-network-error.js";
import { DocumentModal } from "../documents/modal.js";
import { escapeHtml } from "../../shared/html.js";

const runtime = new DocumentRuntimeLoader({
  isTransferFailure: isModuleNetworkError,
  prime: (entry) => prepareDocumentModule(entry ? "/creative-assets.bundle.js?retry=1" : "/creative-assets.bundle.js"),
  evaluate: (entry) => (entry ? import("/creative-assets.bundle.js?retry=1") : import("/creative-assets.bundle.js")),
});
/** Intent loads the optional reader/import UI; leaving its workspace invalidates a late module response. */
export class LazyCreativeAssetsPanel {
  private panel: CreativeAssetsPanel | null = null;
  private epoch = 0;
  private preparing: number | null = null;
  private readonly frame: DocumentModal;
  constructor(
    private readonly t: Translate,
    private readonly id: string,
    private readonly identity: string,
  ) {
    this.frame = new DocumentModal(t, id);
    this.frame.element.classList.add("creative-asset-dialog");
  }
  private begin() {
    this.panel?.close();
    const epoch = ++this.epoch;
    this.preparing = epoch;
    void this.frame
      .form(
        this.t("creative.file"),
        `<p role="status">${escapeHtml(this.t("creative.assetOpening"))}</p>`,
        this.t("documents.close"),
        async () => null,
      )
      .then(() => {
        if (this.preparing === epoch && this.epoch === epoch) this.close();
      });
    return epoch;
  }
  private ready(epoch: number) {
    if (epoch !== this.epoch) return false;
    this.preparing = null;
    this.frame.close();
    return true;
  }
  async open(
    action: "import" | "read" | "copy",
    project: string,
    asset: CreativeAsset | undefined,
    changed: () => Promise<void>,
  ) {
    const epoch = this.begin();
    try {
      const loaded = await runtime.load();
      if (!this.ready(epoch)) return;
      this.panel ??= new loaded.CreativeAssetsPanel(this.t, this.id, this.identity, this.frame);
      if (action === "import") await this.panel.import(project, changed, asset);
      else if (asset && action === "read") await this.panel.read(asset, changed);
      else if (asset) await this.panel.copy(asset);
    } catch (error) {
      if (this.ready(epoch)) throw error;
    }
  }
  async follow(project: string, id: string, changed: () => Promise<void>, version?: string) {
    const epoch = this.begin();
    try {
      const loaded = await runtime.load();
      if (!this.ready(epoch)) return;
      this.panel ??= new loaded.CreativeAssetsPanel(this.t, this.id, this.identity, this.frame);
      await this.panel.read({ project, id, title: this.t("creative.assetOpening"), state: "saved" }, changed, version);
    } catch (error) {
      if (this.ready(epoch)) throw error;
    }
  }
  close() {
    this.epoch++;
    this.preparing = null;
    this.panel?.close();
    this.frame.close();
  }
}
