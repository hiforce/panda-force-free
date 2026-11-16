import type { Translate } from "../../shared/i18n/messages.js";
import { escapeHtml as e } from "../../shared/html.js";
import { setMessageHtml, messageHtml, errorText } from "../i18n.js";

import { DocumentApiError } from "./api.js";

/** Owns form and focus lifetime; feature navigation can close it without accepting a stale response. */
export class DocumentModal {
  readonly element = document.createElement("dialog");
  private epoch = 0;
  private settle: (() => void) | null = null;
  constructor(
    private t: Translate,
    id = "documentDialog",
  ) {
    this.element.id = id;
    this.element.className = "workbench-dialog document-dialog";
    document.body.append(this.element);
    this.element.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
  }
  close() {
    this.epoch++;
    const settle = this.settle;
    this.settle = null;
    this.element.close();
    this.element.replaceChildren();
    settle?.();
  }
  form<T>(
    title: string,
    body: string,
    submitLabel: string,
    submit: (fields: Record<string, string>) => Promise<T>,
    options: { canSubmit?(): boolean; tone?: "primary" | "danger" } = {},
  ): Promise<T | null> {
    this.close();
    const epoch = this.epoch;
    const previous = document.activeElement;
    setMessageHtml(
      this.element,
      `<header><h2>${e(title)}</h2><button type="button" class="wb-button" data-doc-close>${messageHtml("documents.close", undefined, this.t)}</button></header><form class="document-form">${body}<p class="document-form-error" role="alert" hidden></p><footer><button type="submit" class="wb-button ${options.tone === "danger" ? "danger" : "primary"}">${e(submitLabel)}</button></footer></form>`,
    );
    const form = this.element.querySelector<HTMLFormElement>("form")!;
    const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const error = form.querySelector<HTMLElement>(".document-form-error")!;
    button.disabled = !!options.canSubmit && !options.canSubmit();
    this.element.querySelector<HTMLButtonElement>("[data-doc-close]")!.onclick = () => this.close();
    return new Promise((resolve) => {
      let result: T | null = null;
      this.settle = () => {
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
        resolve(result);
      };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (button.disabled || (options.canSubmit && !options.canSubmit())) return;
        button.disabled = true;
        error.hidden = true;
        const fields = Object.fromEntries(
          [...new FormData(form)].map(([k, v]) => [k.replace(/^document-/, ""), String(v)]),
        );
        try {
          const value = await submit(fields);
          if (epoch !== this.epoch) return;
          result = value;
          this.close();
        } catch (reason) {
          if (epoch !== this.epoch) return;
          error.textContent = errorText(
            reason instanceof DocumentApiError ? reason.payload : null,
            this.t,
            "documents.unavailable",
          );
          error.hidden = false;
        } finally {
          button.disabled = !!options.canSubmit && !options.canSubmit();
        }
      };
      this.element.showModal();
    });
  }
  get generation() {
    return this.epoch;
  }
}
