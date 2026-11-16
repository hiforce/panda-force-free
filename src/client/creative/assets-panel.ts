import type { Translate } from "../../shared/i18n/messages.js";
import type { CreativeAsset } from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { DocumentModal } from "../documents/modal.js";
import { DocumentApiError } from "../documents/api.js";
import { errorText, setMessageHtml } from "../i18n.js";
import { creativeAssetsApi } from "./assets-api.js";
import { importCreativeAsset } from "./assets-import.js";
import { copyCreativeAsset } from "./assets-copy.js";
import { creativeAssetDetail } from "./assets-detail.js";
import { KnowledgePanel } from "../knowledge/lazy.js";
type AssetReadTarget = CreativeAsset | (Pick<CreativeAsset, "id" | "project" | "title"> & { state: "saved" });

/** Optional asset UI has one modal/request lifetime; editors and application-owned originals remain separate. */
export class CreativeAssetsPanel {
  private readonly modal: DocumentModal;
  private readonly knowledge: KnowledgePanel;
  private epoch = 0;
  private controller: AbortController | null = null;
  constructor(
    private readonly t: Translate,
    id: string,
    identity: string,
  ) {
    this.modal = new DocumentModal(t, id);
    this.knowledge = new KnowledgePanel(t, identity);
    this.modal.element.classList.add("creative-asset-dialog");
  }
  close() {
    this.epoch++;
    this.controller?.abort();
    this.knowledge.close();
    this.modal.close();
  }
  private begin() {
    this.close();
    this.controller = new AbortController();
    return { epoch: this.epoch, signal: this.controller.signal };
  }
  async import(project: string, changed: () => Promise<void>, previous?: CreativeAsset) {
    const scope = this.begin();
    try {
      const result = await importCreativeAsset(this.modal, this.t, project, scope.signal, previous);
      if (result && scope.epoch === this.epoch) await changed();
    } finally {
      if (scope.epoch === this.epoch) this.controller?.abort();
    }
  }
  async copy(asset: CreativeAsset) {
    const scope = this.begin();
    try {
      await copyCreativeAsset(this.modal, this.t, asset, scope.signal);
    } catch (error) {
      if (scope.epoch === this.epoch && !scope.signal.aborted)
        await this.modal.form(
          this.t("creative.copy"),
          `<p role="alert">${e(errorText(error instanceof DocumentApiError ? error.payload : null, this.t, "documents.unavailable"))}</p>`,
          this.t("documents.close"),
          async () => null,
        );
    } finally {
      if (scope.epoch === this.epoch) this.controller?.abort();
    }
  }
  async read(asset: AssetReadTarget, changed: () => Promise<void>, expectedVersion?: string) {
    if (asset.state === "trashed") return this.restore(asset, changed);
    const scope = this.begin(),
      t = this.t;
    const closed = this.modal.form(
      asset.title,
      `<div data-asset-detail><p role="status">${e(t("documents.loading"))}</p></div>`,
      t("documents.close"),
      async () => null,
    );
    void closed.then(() => {
      if (scope.epoch === this.epoch) this.controller?.abort();
    });
    try {
      const [value, access] = await Promise.all([
        creativeAssetsApi.detail(asset.project, asset.id, scope.signal),
        creativeAssetsApi.capabilities(asset.project, scope.signal),
      ]);
      if (scope.epoch !== this.epoch || scope.signal.aborted) return;
      const body = this.modal.element.querySelector<HTMLElement>("[data-asset-detail]")!;
      const title = this.modal.element.querySelector("header h2")!;
      title.textContent = value.asset.title;
      title.setAttribute("data-i18n-ignore", "");
      if (expectedVersion && expectedVersion !== value.asset.version) {
        body.textContent = t("creative.assetVersionChanged");
        return;
      }
      setMessageHtml(body, creativeAssetDetail(t, value, access.contribute));
      const preview = body.querySelector("[data-asset-preview]");
      if (preview && value.previewHtml) {
        const frame = document.createElement("iframe");
        frame.className = "creative-asset-frame";
        frame.dataset.assetFrame = "";
        frame.setAttribute("sandbox", "");
        frame.referrerPolicy = "no-referrer";
        frame.title = t("creative.assetStaticPreview");
        frame.srcdoc = value.previewHtml;
        preview.append(frame);
      }
      body.querySelector<HTMLButtonElement>("[data-asset-copy]")!.onclick = () => {
        void this.copy(value.asset);
      };
      body.querySelector<HTMLButtonElement>("[data-asset-replace]")?.addEventListener("click", () => {
        void this.import(asset.project, changed, value.asset);
      });
      body.querySelector<HTMLButtonElement>("[data-asset-trash]")?.addEventListener("click", () => {
        void this.trash(value.asset, changed);
      });
      body.querySelector<HTMLButtonElement>("[data-asset-knowledge]")?.addEventListener("click", () => {
        void this.knowledge.open({
          project: asset.project,
          sources: [{ id: value.asset.id, title: value.asset.title, kind: value.asset.kind }],
          selected: [value.asset.id],
        });
      });
    } catch (error) {
      if (scope.epoch !== this.epoch || scope.signal.aborted) return;
      this.modal.element.querySelector("[data-asset-detail]")!.textContent = errorText(
        error instanceof DocumentApiError ? error.payload : null,
        t,
        "documents.unavailable",
      );
    }
  }
  private async trash(asset: CreativeAsset, changed: () => Promise<void>) {
    const scope = this.begin(),
      operationId = crypto.randomUUID();
    const result = await this.modal.form(
      this.t("creative.assetTrash"),
      `<p>${e(this.t("creative.assetTrashHint"))}</p><p data-i18n-ignore>${e(asset.title)}</p>`,
      this.t("creative.assetTrash"),
      () => creativeAssetsApi.trash(asset, operationId),
      { tone: "danger" },
    );
    if (result && scope.epoch === this.epoch) await changed();
  }
  private async restore(asset: CreativeAsset, changed: () => Promise<void>) {
    const scope = this.begin(),
      operationId = crypto.randomUUID();
    const result = await this.modal.form(
      this.t("creative.assetRestore"),
      `<p>${e(this.t("creative.assetTrashScope"))}</p><p data-i18n-ignore>${e(asset.title)}</p>`,
      this.t("creative.assetRestore"),
      () => creativeAssetsApi.restore(asset, operationId),
    );
    if (result && scope.epoch === this.epoch) await changed();
  }
}
