import type { Translate } from "../../../shared/i18n/messages.js";
import type { CreativeAsset } from "../../../shared/creative/assets.js";
import { creativeFileExtension, creativeKindIcons, creativeKindMessages } from "../../../shared/creative/file-types.js";
import { escapeHtml as e } from "../../../shared/html.js";
import { codexIcon } from "../../codex-icons.js";
import { getBrowserI18n, setMessageHtml } from "../../i18n.js";
import { creativeAssetsApi } from "../../creative/assets-api.js";
import { CreativeCovers } from "../../creative/covers.js";
import { personalWorkCard } from "./personal-work-card.js";
import { LazyCreativeAssetsPanel } from "../../creative/assets-lazy.js";

/** File metadata has its own lifetime and never becomes a document tree mutation or an editor selection. */
export class AuthoringAssetDirectory {
  readonly element = document.createElement("section");
  private readonly reader: LazyCreativeAssetsPanel;
  private readonly covers: CreativeCovers;
  private cardView = false;
  private project = "";
  private epoch = 0;
  private lifetime = 0;
  private read: AbortController | null = null;
  private assets: CreativeAsset[] = [];
  private cursor: string | null = null;
  private query = "";
  private state: "saved" | "trashed" = "saved";
  private category: { kind?: CreativeAsset["kind"]; state: "saved" | "trashed" } | undefined;
  private loading = false;
  private failed = false;
  private contribute = false;
  private retryOpen: (() => Promise<void>) | null = null;
  constructor(
    private readonly t: Translate,
    identity: string,
    private readonly beforeOpen: () => void,
    private readonly openInline?: (asset: CreativeAsset) => void,
    private readonly showPersonalImport?: (available: boolean) => void,
  ) {
    this.element.className = "authoring-files";
    this.element.hidden = true;
    this.reader = new LazyCreativeAssetsPanel(t, "authoringFileDialog", identity);
    this.covers = new CreativeCovers(t);
    getBrowserI18n().subscribe(() => {
      if (this.category && this.element.isConnected) this.render();
    });
    this.element.addEventListener("click", (event) => {
      const trigger = (event.target as Element).closest<HTMLButtonElement>("[data-file-action]");
      if (!trigger || trigger.disabled) return;
      const action = trigger.dataset.fileAction;
      if (action === "refresh") void this.refresh();
      else if (action === "more") void this.fetch(true);
      else if (action === "trash" || action === "saved") {
        this.state = action === "trash" ? "trashed" : "saved";
        this.assets = [];
        this.cursor = null;
        void this.refresh();
      } else if (action === "retry-open" && this.retryOpen) void this.openPanel(this.retryOpen);
      else if (action === "import") void this.importFile();
      else if (action === "open") {
        const asset = this.assets.find((value) => value.id === trigger.dataset.fileId);
        if (asset?.state === "saved" && this.category && this.openInline) this.openInline(asset);
        else if (asset) void this.openPanel(() => this.reader.open("read", asset.project, asset, () => this.refresh()));
      }
    });
  }
  open(project: string, category?: { kind?: CreativeAsset["kind"]; state: "saved" | "trashed" }) {
    this.close();
    this.project = project;
    this.category = category;
    this.state = category?.state ?? "saved";
    this.element.classList.toggle("authoring-files-library", !!category);
    this.element.hidden = false;
    void this.refresh();
  }
  close() {
    this.epoch++;
    this.lifetime++;
    this.read?.abort();
    this.reader.close();
    this.covers.close();
    this.project = "";
    this.assets = [];
    this.cursor = null;
    this.query = "";
    this.state = "saved";
    this.category = undefined;
    this.loading = false;
    this.failed = false;
    this.contribute = false;
    this.retryOpen = null;
    this.element.hidden = true;
    this.showPersonalImport?.(false);
    this.element.replaceChildren();
  }
  setCardView(cards: boolean) {
    if (cards === this.cardView) return;
    this.cardView = cards;
    this.render();
  }
  search(query: string) {
    this.query = query.trim().toLocaleLowerCase();
    this.render();
  }
  refresh() {
    return this.fetch(false);
  }
  async importFile() {
    if (!this.contribute || !this.project || (this.category && this.state !== "saved")) return;
    await this.openPanel(() => this.reader.open("import", this.project, undefined, () => this.refresh()));
  }
  async follow(project: string, id: string, version: string) {
    if (project !== this.project) return;
    void this.refresh();
    await this.openPanel(() => this.reader.follow(project, id, () => this.refresh(), version));
  }
  private async openPanel(open: () => Promise<void>) {
    const lifetime = this.lifetime;
    this.retryOpen = null;
    this.beforeOpen();
    this.render();
    try {
      await open();
    } catch {
      if (lifetime !== this.lifetime) return;
      this.retryOpen = open;
      this.render();
    }
  }
  private async fetch(more: boolean) {
    if (!this.project || (more && (this.loading || !this.cursor))) return;
    this.read?.abort();
    const controller = new AbortController(),
      epoch = ++this.epoch;
    this.read = controller;
    this.loading = true;
    this.failed = false;
    this.render();
    try {
      const [page, capabilities] = await Promise.all([
        creativeAssetsApi.list(
          this.project,
          more ? this.cursor! : undefined,
          controller.signal,
          this.state,
          this.category?.kind,
        ),
        creativeAssetsApi.capabilities(this.project, controller.signal),
      ]);
      if (epoch !== this.epoch || controller.signal.aborted) return;
      if (capabilities.originals === false) {
        this.element.hidden = true;
        this.contribute = false;
        return;
      }
      this.contribute = capabilities.contribute;
      this.assets = [
        ...new Map([...(more ? this.assets : []), ...page.assets].map((asset) => [asset.id, asset])).values(),
      ];
      this.cursor = page.nextCursor;
    } catch {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      this.failed = true;
    } finally {
      if (epoch === this.epoch && !controller.signal.aborted) {
        this.loading = false;
        this.render();
      }
    }
  }
  private render() {
    if (!this.project) return;
    this.element.setAttribute("aria-busy", String(this.loading));
    this.showPersonalImport?.(Boolean(this.category && this.state === "saved" && this.contribute));
    const t = this.t,
      host = this.element.parentElement,
      top = host?.scrollTop,
      active = document.activeElement,
      focus =
        active instanceof HTMLElement && this.element.contains(active)
          ? { action: active.dataset.fileAction, id: active.dataset.fileId }
          : null;
    const button = (action: string, label: string, extra = "") =>
      `<button type="button" class="wb-button" data-file-action="${action}" ${extra}>${e(label)}</button>`;
    const items = this.assets.filter((asset) =>
      [asset.title, asset.source.name, t(creativeKindMessages[asset.kind])].some((value) =>
        value.toLocaleLowerCase().includes(this.query),
      ),
    );
    const asCards = this.category && this.cardView && this.state === "saved";
    const date = new Intl.DateTimeFormat(document.documentElement.lang || "en", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    const rows = items.map((asset) => {
      const label = t(asset.state === "purging" ? "creative.assetPurging" : creativeKindMessages[asset.kind]);
      const format = creativeFileExtension(asset.source.name).toUpperCase();
      const metadata = asCards ? format + " · " + date.format(asset.updatedAt) : label + " · " + format;
      const action = `data-file-action="open" data-file-id="${e(asset.id)}"`;
      const icon = creativeKindIcons[asset.kind];
      if (asCards)
        return personalWorkCard(t, {
          kind: asset.kind,
          title: asset.title,
          metadata,
          icon,
          action,
          cover: ["image", "slides", "video"].includes(asset.kind) ? creativeAssetsApi.cover(asset) : undefined,
        });
      return `<button type="button" class="authoring-files-item" ${action} title="${e(asset.title)}">${codexIcon(icon)}<span><strong data-i18n-ignore>${e(asset.title)}</strong><small>${e(metadata)}</small></span></button>`;
    });
    setMessageHtml(
      this.element,
      `${this.category ? "" : `<header class="authoring-files-heading"><strong>${e(t("creative.file"))}</strong><div>${this.contribute ? button("import", t("creative.assetImport")) : ""}</div></header><div class="authoring-files-tabs">${button("saved", t("creative.saved"), `aria-pressed="${this.state === "saved"}"`)}${button("trash", t("creative.assetFileTrash"), `aria-pressed="${this.state === "trashed"}"`)}</div>`}
      <div class="authoring-files-list${asCards && rows.length ? " personal-works-grid" : ""}">${rows.join("")}</div>
      ${this.loading ? `<p class="authoring-files-status" role="status">${e(t("creative.assetLoading"))}</p>` : ""}
      ${this.failed ? `<p class="authoring-files-status" role="status">${e(t("creative.assetLoadFailed"))}</p>${button("refresh", t("common.retry"))}` : !this.loading && !items.length ? `<p class="authoring-files-status">${e(t(this.query ? "creative.assetNoMatches" : this.state === "trashed" ? "creative.assetTrashEmpty" : "creative.assetEmptySaved"))}</p>` : ""}
      ${this.retryOpen ? `<p class="authoring-files-status" role="status">${e(t("creative.assetOpenFailed"))}</p>${button("retry-open", t("common.retry"))}` : ""}
      ${this.cursor ? `<p class="authoring-files-status">${e(t("creative.assetMoreAvailable"))}</p>${button("more", t("creative.assetLoadMore"), this.loading ? "disabled" : "")}` : ""}`,
    );
    if (this.category) this.covers.render(this.element);
    if (host && top !== undefined) host.scrollTop = top;
    if (focus?.action)
      [...this.element.querySelectorAll<HTMLButtonElement>("[data-file-action]")]
        .find((node) => node.dataset.fileAction === focus.action && node.dataset.fileId === focus.id)
        ?.focus({ preventScroll: true });
  }
}
