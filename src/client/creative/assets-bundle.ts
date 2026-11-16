import type { Translate } from "../../shared/i18n/messages.js";
import { CREATIVE_ASSET_LIMITS as limits } from "../../shared/creative/assets.js";
import type { DocumentModal } from "../documents/modal.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml } from "../i18n.js";
import { creativeAssetsApi } from "./assets-api.js";

/** A readonly archive inspection belongs to this form generation; late files or responses cannot select an entry. */
export class CreativeBundleSelection {
  private readonly epoch: number;
  private file: File | undefined;
  private ready = false;
  private read: AbortController | null = null;
  private sequence = 0;
  constructor(
    private modal: DocumentModal,
    private t: Translate,
    private project: string,
    private signal: AbortSignal,
    private changed: () => void,
  ) {
    this.epoch = modal.generation;
    this.selectElement.onchange = changed;
    modal.element.querySelector<HTMLButtonElement>("[data-asset-bundle-retry]")!.onclick = () =>
      void this.load(this.file);
  }
  private get selectElement() {
    return this.modal.element.querySelector<HTMLSelectElement>("[name=document-entry]")!;
  }
  get active() {
    return !this.signal.aborted && this.modal.generation === this.epoch;
  }
  entry(file: File) {
    return this.active && this.file === file && this.ready ? this.selectElement.value : "";
  }
  close() {
    this.sequence++;
    this.read?.abort();
  }
  async load(file?: File) {
    this.close();
    if (!this.active) return;
    const sequence = this.sequence,
      prior = this.file === file ? this.selectElement.value : "",
      wrapper = this.modal.element.querySelector<HTMLElement>("[data-asset-bundle-fields]")!,
      status = this.modal.element.querySelector<HTMLElement>("[data-asset-bundle-status]")!,
      retry = this.modal.element.querySelector<HTMLButtonElement>("[data-asset-bundle-retry]")!;
    this.file = file;
    this.ready = false;
    this.selectElement.replaceChildren();
    wrapper.hidden = !file?.name.toLowerCase().endsWith(".zip");
    retry.hidden = true;
    this.changed();
    if (wrapper.hidden || !file) return;
    if (!file.size || file.size > limits.sourceBytes) {
      status.textContent = this.t("creative.assetInvalidFile");
      return;
    }
    const read = new AbortController();
    this.read = read;
    this.selectElement.disabled = true;
    status.textContent = this.t("creative.assetBundleInspecting");
    try {
      const result = await creativeAssetsApi.inspectBundle(
        this.project,
        file,
        AbortSignal.any([this.signal, read.signal]),
      );
      if (!this.active || read.signal.aborted || sequence !== this.sequence) return;
      setMessageHtml(
        this.selectElement,
        `<option value="">${e(this.t("creative.assetBundleChooseEntry"))}</option>` +
          result.entries
            .map((entry) => `<option value="${e(entry.name)}" data-i18n-ignore>${e(entry.name)}</option>`)
            .join(""),
      );
      this.selectElement.value = result.entries.some((entry) => entry.name === prior)
        ? prior
        : (result.defaultEntry ?? "");
      const numbers = new Intl.NumberFormat(document.documentElement.lang || "en");
      status.textContent = this.t("creative.assetBundleSummary", {
        files: result.files,
        bytes: numbers.format(result.totalBytes),
      });
      this.ready = true;
    } catch {
      if (this.active && !read.signal.aborted && sequence === this.sequence) {
        status.textContent = this.t("creative.assetBundleInspectFailed");
        retry.hidden = false;
      }
    } finally {
      if (this.active && sequence === this.sequence) {
        this.selectElement.disabled = !this.ready;
        this.changed();
      }
    }
  }
}
