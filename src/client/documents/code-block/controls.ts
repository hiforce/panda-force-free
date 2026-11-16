import type { Translate } from "../../../shared/i18n/messages.js";
import { codeLanguageIdentity, codeLanguageLabels } from "../../../shared/documents/code-languages.js";
import { escapeHtml } from "../../../shared/html.js";
import { copyPlainText } from "../../clipboard-text.js";
import { codexIcon } from "../../codex-icons.js";
import { setMessageHtml } from "../../i18n.js";
import type { CodeLanguagePicker } from "./language-picker.js";
export interface CodeBlockControlOptions {
  text(): string;
  language(): string;
  editable(): boolean;
  setLanguage(language: string): void;
  setWrap(wrap: boolean): void;
  error(value: unknown): void;
}
/** Display-only controls are shared by the static reader and embedded editor; they never own source state. */
export class CodeBlockControls {
  readonly element = document.createElement("div");
  private readonly language = document.createElement("button");
  private readonly wrapButton = document.createElement("button");
  private readonly copyButton = document.createElement("button");
  private readonly notice = document.createElement("span");
  private closed = false;
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  wrap = true;
  constructor(
    private readonly t: Translate,
    private readonly options: CodeBlockControlOptions,
    private readonly picker?: CodeLanguagePicker,
  ) {
    this.element.className = "document-code-toolbar";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", t("codeBlocks.title"));
    const title = document.createElement("span");
    title.textContent = t("codeBlocks.title");
    title.className = "document-code-title";
    for (const button of [this.language, this.wrapButton, this.copyButton]) {
      button.type = "button";
      button.className = "document-code-button";
    }
    this.language.dataset.codeLanguage = "";
    this.language.setAttribute("aria-haspopup", "dialog");
    this.language.setAttribute("aria-expanded", "false");
    this.wrapButton.dataset.codeWrap = "";
    this.copyButton.dataset.codeCopy = "";
    this.notice.className = "document-code-notice";
    this.notice.setAttribute("role", "status");
    this.element.append(title, this.language, this.wrapButton, this.copyButton, this.notice);
    try {
      this.wrap = localStorage.getItem("panda.document-code-wrap") !== "false";
    } catch {
      /* Display preferences remain optional. */
    }
    this.language.onclick = () => {
      if (this.options.editable())
        this.picker?.open(this.language, this.options.language(), (value) => {
          if (!this.closed && this.options.editable()) this.options.setLanguage(value);
        });
    };
    this.wrapButton.onclick = () => {
      this.wrap = !this.wrap;
      try {
        localStorage.setItem("panda.document-code-wrap", String(this.wrap));
      } catch {
        /* This view remains usable without storage. */
      }
      this.options.setWrap(this.wrap);
      this.update();
    };
    this.copyButton.onclick = () => {
      this.copyButton.disabled = true;
      void copyPlainText(this.options.text())
        .then(() => {
          if (!this.closed) {
            this.notice.textContent = t("codeBlocks.copied");
            clearTimeout(this.copyTimer);
            this.copyTimer = setTimeout(() => {
              this.notice.textContent = "";
            }, 1800);
          }
        })
        .catch((error) => {
          if (!this.closed) this.options.error(error);
        })
        .finally(() => {
          if (!this.closed) this.copyButton.disabled = false;
        });
    };
    this.update();
  }
  update() {
    const id = codeLanguageIdentity(this.options.language()),
      label =
        id === "plaintext"
          ? this.t("codeBlocks.plainText")
          : id
            ? codeLanguageLabels[id]!.label
            : this.options.language();
    this.language.textContent = label + (this.options.editable() ? " ▾" : "");
    this.language.disabled = !this.options.editable();
    this.language.setAttribute("aria-label", this.t("codeBlocks.currentLanguage", { language: label }));
    const wrapLabel = this.t(this.wrap ? "codeBlocks.disableWrap" : "codeBlocks.enableWrap");
    setMessageHtml(
      this.wrapButton,
      codexIcon("wrapText") + `<span class="document-code-button-label">${escapeHtml(wrapLabel)}</span>`,
    );
    this.wrapButton.setAttribute("aria-label", wrapLabel);
    this.wrapButton.title = wrapLabel;
    this.wrapButton.setAttribute("aria-pressed", String(this.wrap));
    setMessageHtml(
      this.copyButton,
      codexIcon("copy") + `<span class="document-code-button-label">${escapeHtml(this.t("codeBlocks.copy"))}</span>`,
    );
    this.copyButton.setAttribute("aria-label", this.t("codeBlocks.copy"));
    this.copyButton.title = this.t("codeBlocks.copy");
  }
  setEditable() {
    this.picker?.detach(this.language);
    this.update();
  }
  close() {
    this.closed = true;
    clearTimeout(this.copyTimer);
    this.picker?.detach(this.language);
    this.element.remove();
  }
}
