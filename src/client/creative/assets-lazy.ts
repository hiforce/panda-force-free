import type { Translate } from "../../shared/i18n/messages.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import type { CreativeAssetsPanel } from "./assets-panel.js";
import { DocumentRuntimeLoader } from "../documents/runtime-loader.js";
import { prepareDocumentModule } from "../documents/module-transfer.js";
import { isModuleNetworkError } from "../documents/module-network-error.js";

const runtime = new DocumentRuntimeLoader({
  isTransferFailure: isModuleNetworkError,
  prime: (entry) => prepareDocumentModule(entry ? "/creative-assets.bundle.js?retry=1" : "/creative-assets.bundle.js"),
  evaluate: (entry) => (entry ? import("/creative-assets.bundle.js?retry=1") : import("/creative-assets.bundle.js")),
});
/** Intent loads the optional reader/import UI; leaving its workspace invalidates a late module response. */
export class LazyCreativeAssetsPanel {
  private panel: CreativeAssetsPanel | null = null;
  private epoch = 0;
  constructor(
    private readonly t: Translate,
    private readonly id: string,
    private readonly identity: string,
  ) {}
  async open(
    action: "import" | "read" | "copy",
    project: string,
    asset: CreativeAsset | undefined,
    changed: () => Promise<void>,
  ) {
    const epoch = ++this.epoch,
      loaded = await runtime.load();
    if (epoch !== this.epoch) return;
    this.panel ??= new loaded.CreativeAssetsPanel(this.t, this.id, this.identity);
    if (action === "import") await this.panel.import(project, changed, asset);
    else if (asset && action === "read") await this.panel.read(asset, changed);
    else if (asset) await this.panel.copy(asset);
  }
  async follow(project: string, id: string, changed: () => Promise<void>, version?: string) {
    const epoch = ++this.epoch,
      loaded = await runtime.load();
    if (epoch !== this.epoch) return;
    this.panel ??= new loaded.CreativeAssetsPanel(this.t, this.id, this.identity);
    await this.panel.read({ project, id, title: this.t("documents.loading"), state: "saved" }, changed, version);
  }
  close() {
    this.epoch++;
    this.panel?.close();
  }
}
