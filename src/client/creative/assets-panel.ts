import { bindSlidePreview } from "./slides-preview.js";
import { bindReaderMore } from "./reader-toolbar.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { CreativeAsset, CreativeAssetKind } from "../../shared/creative/assets.js";
import { escapeHtml as e } from "../../shared/html.js";
import { DocumentModal } from "../documents/modal.js";
import { DocumentApiError } from "../documents/api.js";
import { errorText, setMessageHtml } from "../i18n.js";
import { creativeAssetsApi } from "./assets-api.js";
import { importCreativeAsset } from "./assets-import.js";
import { copyCreativeAsset } from "./assets-copy.js";
import { creativeAssetDetail } from "./assets-detail.js";
import { KnowledgePanel } from "../knowledge/lazy.js";
import { bindAssetLink } from "./assets-link.js";
type AssetReadTarget = CreativeAsset | (Pick<CreativeAsset, "id" | "project" | "title"> & { state: "saved" });

/** Optional asset UI has one modal/request lifetime; editors and application-owned originals remain separate. */
export class CreativeAssetsPanel {
  private readonly modal: DocumentModal;
  private readonly knowledge: KnowledgePanel;
  private epoch = 0;
  private purgePoll: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;
  constructor(
    private readonly t: Translate,
    id: string,
    identity: string,
    frame?: DocumentModal,
  ) {
    this.modal = frame ?? new DocumentModal(t, id);
    this.knowledge = new KnowledgePanel(t, identity);
    this.modal.element.classList.add("creative-asset-dialog");
  }
  close() {
    clearTimeout(this.purgePoll);
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
  async import(project: string, changed: () => Promise<void>, previous?: CreativeAsset, kind?: CreativeAssetKind) {
    const scope = this.begin();
    try {
      const result = await importCreativeAsset(this.modal, this.t, project, scope.signal, previous, kind);
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
    if (asset.state === "purging" || asset.state === "purged") return this.cleanup(asset, changed);
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
    await this.readSurface(
      asset,
      changed,
      this.modal.element.querySelector<HTMLElement>("[data-asset-detail]")!,
      this.modal.element.querySelector<HTMLElement>("header h2")!,
      scope,
      () => this.read(asset, changed, expectedVersion),
      expectedVersion,
    );
  }
  async readInline(
    asset: AssetReadTarget,
    changed: () => Promise<void>,
    body: HTMLElement,
    title: HTMLElement,
    toolbar: HTMLElement,
    expectedVersion?: string,
  ): Promise<CreativeAsset | undefined> {
    const scope = this.begin();
    return this.readSurface(
      asset,
      changed,
      body,
      title,
      scope,
      () => this.readInline(asset, changed, body, title, toolbar, expectedVersion),
      expectedVersion,
      toolbar,
    );
  }
  private async readSurface(
    asset: AssetReadTarget,
    changed: () => Promise<void>,
    body: HTMLElement,
    title: HTMLElement,
    scope: { epoch: number; signal: AbortSignal },
    retry: () => Promise<unknown>,
    expectedVersion?: string,
    toolbar?: HTMLElement,
  ) {
    const t = this.t;
    try {
      const [value, access] = await Promise.all([
        creativeAssetsApi.detail(asset.project, asset.id, scope.signal),
        creativeAssetsApi.capabilities(asset.project, scope.signal),
      ]);
      if (scope.epoch !== this.epoch || scope.signal.aborted) return;
      title.textContent = value.asset.title;
      if (toolbar) title.title = value.asset.title;
      title.setAttribute("data-i18n-ignore", "");
      if (expectedVersion && expectedVersion !== value.asset.version) {
        body.textContent = t("creative.assetVersionChanged");
        return value.asset;
      }
      const presentation = creativeAssetDetail(t, value, access.contribute, !!toolbar),
        surface = toolbar?.closest<HTMLElement>("[data-personal-reader], [data-project-asset-reader]") ?? body;
      if (toolbar) {
        setMessageHtml(toolbar, presentation.toolbar);
        const actions = toolbar.querySelector<HTMLDetailsElement>(".personal-asset-more")!;
        actions.addEventListener("click", (event) => {
          if (
            (event.target as Element).closest(
              "[data-asset-copy],[data-asset-replace],[data-asset-trash],[data-asset-knowledge]",
            )
          ) {
            actions.open = false;
            actions.querySelector("summary")?.focus({ preventScroll: true });
          }
        });
        bindReaderMore(toolbar, scope.signal);
      }
      setMessageHtml(body, presentation.body);
      bindAssetLink(surface, value.asset, t, scope.signal);
      bindSlidePreview(body, value.asset, t, scope.signal);
      this.bindRetry(body, retry);
      for (const element of body.querySelectorAll("[data-asset-native]"))
        element.addEventListener("error", () => {
          const notice = body.querySelector<HTMLElement>("[data-asset-view-error]");
          if (notice) notice.hidden = false;
        });
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
      surface.querySelector<HTMLButtonElement>("[data-asset-copy]")!.onclick = () => {
        void this.copy(value.asset);
      };
      surface.querySelector<HTMLButtonElement>("[data-asset-replace]")?.addEventListener("click", () => {
        void this.import(asset.project, changed, value.asset);
      });
      surface.querySelector<HTMLButtonElement>("[data-asset-trash]")?.addEventListener("click", () => {
        void this.trash(value.asset, changed);
      });
      surface.querySelector<HTMLButtonElement>("[data-asset-knowledge]")?.addEventListener("click", () => {
        const kind = value.asset.kind;
        if (kind !== "web" && kind !== "slides") return;
        void this.knowledge.open({
          project: asset.project,
          sources: [{ id: value.asset.id, title: value.asset.title, kind }],
          selected: [value.asset.id],
        });
      });
      return value.asset;
    } catch (error) {
      if (scope.epoch !== this.epoch || scope.signal.aborted) return;
      const message = errorText(error instanceof DocumentApiError ? error.payload : null, t, "documents.unavailable");
      const version = expectedVersion ?? ("version" in asset ? asset.version : undefined),
        download = version && (!(error instanceof DocumentApiError) || ![403, 404, 409].includes(error.status));
      setMessageHtml(
        body,
        `<p role="status">${e(message)}</p><button type="button" class="wb-button" data-asset-view-retry>${e(t("common.retry"))}</button>${download ? `<a class="wb-button" href="${e(creativeAssetsApi.content(asset.project, asset.id, version!))}" download>${e(t("creative.assetDownload"))}</a>` : ""}`,
      );
      this.bindRetry(body, retry);
    }
  }
  private bindRetry(body: HTMLElement, read: () => Promise<unknown>) {
    const retry = body.querySelector<HTMLButtonElement>("[data-asset-view-retry]");
    if (retry)
      retry.onclick = () => {
        retry.disabled = true;
        void read();
      };
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
    let ready = false,
      contribute = false;
    const result = this.modal.form(
      this.t("creative.assetRestore"),
      `<p>${e(this.t("creative.assetTrashScope"))}</p><p data-i18n-ignore>${e(asset.title)}</p><p data-asset-trash-access role="status">${e(this.t("documents.loading"))}</p><button type="button" class="wb-button danger" data-asset-permanent hidden>${e(this.t("creative.assetPermanentDelete"))}</button>`,
      this.t("creative.assetRestore"),
      () => (contribute ? creativeAssetsApi.restore(asset, operationId) : Promise.resolve(null)),
      { canSubmit: () => ready },
    );
    void result.then(async (value) => {
      if (scope.epoch === this.epoch) {
        this.controller?.abort();
        if (value) await changed();
      }
    });
    try {
      const access = await creativeAssetsApi.capabilities(asset.project, scope.signal);
      if (scope.epoch !== this.epoch || scope.signal.aborted) return;
      ready = true;
      contribute = access.contribute;
      const notice = this.modal.element.querySelector<HTMLElement>("[data-asset-trash-access]");
      if (notice) notice.textContent = "";
      const submit = this.modal.element.querySelector<HTMLButtonElement>('[type="submit"]')!;
      submit.disabled = false;
      if (!contribute) submit.textContent = this.t("documents.close");
      const remove = this.modal.element.querySelector<HTMLButtonElement>("[data-asset-permanent]")!;
      remove.hidden = !contribute;
      remove.onclick = () => {
        void this.permanentDelete(asset, changed);
      };
    } catch (error) {
      if (scope.epoch !== this.epoch || scope.signal.aborted) return;
      const notice = this.modal.element.querySelector<HTMLElement>("[data-asset-trash-access]");
      if (notice)
        notice.textContent = errorText(
          error instanceof DocumentApiError ? error.payload : null,
          this.t,
          "documents.unavailable",
        );
    }
  }
  private async permanentDelete(asset: CreativeAsset, changed: () => Promise<void>) {
    const scope = this.begin(),
      operationId = crypto.randomUUID();
    const result = await this.modal.form(
      this.t("creative.assetPermanentDelete"),
      `<p>${e(this.t("creative.assetPermanentHint"))}</p><p data-i18n-ignore>${e(asset.title)}</p>`,
      this.t("creative.assetPermanentDelete"),
      () => creativeAssetsApi.permanentDelete(asset, operationId, scope.signal),
      { tone: "danger" },
    );
    if (!result || scope.epoch !== this.epoch) return;
    await changed();
    if (scope.epoch === this.epoch) await this.cleanup(result.asset, changed);
  }
  private async cleanup(asset: CreativeAsset, changed: () => Promise<void>) {
    const scope = this.begin(),
      t = this.t;
    const closed = this.modal.form(
      asset.title,
      `<p data-asset-purge-notice role="status">${e(t(asset.state === "purged" ? "creative.assetPurgeComplete" : "creative.assetPurgePending"))}</p><p data-asset-purge-error role="status"></p><div class="creative-asset-actions" data-asset-purge-actions><button type="button" class="wb-button" data-asset-purge-check>${e(t("creative.assetPurgeCheck"))}</button><button type="button" class="wb-button" data-asset-purge-retry hidden>${e(t("creative.assetPurgeRetry"))}</button></div>`,
      t("documents.close"),
      async () => null,
    );
    void closed.then(() => {
      if (scope.epoch === this.epoch) {
        this.controller?.abort();
        clearTimeout(this.purgePoll);
      }
    });
    let busy = false,
      polls = 0;
    const buttons = () => [
      ...this.modal.element.querySelectorAll<HTMLButtonElement>("[data-asset-purge-actions] button"),
    ];
    const update = async (retry = false) => {
      if (busy || scope.signal.aborted || scope.epoch !== this.epoch) return;
      busy = true;
      for (const button of buttons()) button.disabled = true;
      try {
        const value = await creativeAssetsApi.purge(asset, retry, scope.signal);
        if (scope.signal.aborted || scope.epoch !== this.epoch) return;
        const completed = value.status.state === "complete",
          notice = this.modal.element.querySelector<HTMLElement>("[data-asset-purge-notice]")!,
          error = this.modal.element.querySelector<HTMLElement>("[data-asset-purge-error]")!;
        notice.textContent = t(completed ? "creative.assetPurgeComplete" : "creative.assetPurgePending");
        error.textContent = !completed && value.status.code ? t("creative.assetPurgeFailed") : "";
        const actions = this.modal.element.querySelector<HTMLElement>("[data-asset-purge-actions]")!;
        actions.hidden = completed;
        if (completed) {
          clearTimeout(this.purgePoll);
          await changed();
        } else if (++polls < 20)
          this.purgePoll = setTimeout(() => {
            void update();
          }, 3000);
      } catch (reason) {
        if (scope.signal.aborted || scope.epoch !== this.epoch) return;
        const error = this.modal.element.querySelector<HTMLElement>("[data-asset-purge-error]");
        if (error)
          error.textContent = errorText(
            reason instanceof DocumentApiError ? reason.payload : null,
            t,
            "documents.unavailable",
          );
      } finally {
        busy = false;
        if (scope.epoch === this.epoch) for (const button of buttons()) button.disabled = false;
      }
    };
    try {
      const access = await creativeAssetsApi.capabilities(asset.project, scope.signal);
      if (scope.signal.aborted || scope.epoch !== this.epoch) return;
      if (!access.contribute) {
        this.modal.element.querySelector<HTMLElement>("[data-asset-purge-actions]")!.hidden = true;
        return;
      }
      const retry = this.modal.element.querySelector<HTMLButtonElement>("[data-asset-purge-retry]")!;
      retry.hidden = false;
      retry.onclick = () => {
        clearTimeout(this.purgePoll);
        void update(true);
      };
      this.modal.element.querySelector<HTMLButtonElement>("[data-asset-purge-check]")!.onclick = () => {
        clearTimeout(this.purgePoll);
        void update();
      };
      if (asset.state !== "purged") await update();
      else this.modal.element.querySelector<HTMLElement>("[data-asset-purge-actions]")!.hidden = true;
    } catch {
      /* The last committed state remains readable when optional management capabilities fail. */
    }
  }
}
