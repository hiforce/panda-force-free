import type { Translate } from "../../../shared/i18n/messages.js";
import { codeLanguageLabels, codeLanguageIdentity } from "../../../shared/documents/code-languages.js";
import { documentOverlayHost, placeDocumentPopover } from "../rich-popover.js";
/** One searchable picker belongs to an editor; individual blocks own no global listeners or menus. */
export class CodeLanguagePicker {
  private readonly menu = document.createElement("div");
  private readonly search = document.createElement("input");
  private readonly list = document.createElement("div");
  private readonly listeners = new AbortController();
  private anchor: HTMLElement | null = null;
  private selected = "";
  private choose: ((language: string) => void) | null = null;
  constructor(
    private readonly surface: HTMLElement,
    private readonly t: Translate,
  ) {
    this.menu.className = "document-rich-popover document-code-language-menu";
    this.menu.hidden = true;
    this.menu.setAttribute("role", "dialog");
    this.menu.setAttribute("aria-label", t("codeBlocks.language"));
    this.search.type = "search";
    this.search.placeholder = t("codeBlocks.search");
    this.search.setAttribute("aria-label", t("codeBlocks.search"));
    this.list.className = "document-code-language-options";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", t("codeBlocks.language"));
    this.menu.append(this.search, this.list);
    documentOverlayHost(surface).append(this.menu);
    const signal = this.listeners.signal;
    this.search.addEventListener("input", () => this.render(), { signal });
    this.list.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-code-language-option]");
        if (button) {
          this.choose?.(button.dataset.codeLanguageOption!);
          this.hide(true);
        }
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.menu.contains(event.target as Node) && !this.anchor?.contains(event.target as Node)) this.hide();
      },
      { signal },
    );
    this.menu.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.hide(true);
        }
        if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
          (event.target !== this.search || ["ArrowDown", "ArrowUp"].includes(event.key))
        ) {
          const buttons = [...this.list.querySelectorAll<HTMLButtonElement>("button")],
            index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus({ preventScroll: true });
          buttons[next]?.scrollIntoView({ block: "nearest" });
        }
      },
      { signal },
    );
    document.addEventListener(
      "scroll",
      (event) => {
        if (!this.menu.contains(event.target as Node) && !matchMedia("(max-width: 700px)").matches) this.hide();
      },
      { signal, capture: true, passive: true },
    );
    window.addEventListener(
      "resize",
      () => {
        if (!matchMedia("(max-width: 700px)").matches) this.hide();
      },
      { signal },
    );
  }
  private render() {
    const query = this.search.value.trim().toLowerCase();
    this.list.replaceChildren();
    for (const language of Object.entries(codeLanguageLabels)
      .map(([id, value]) => ({ id, ...value }))
      .filter((value) => [value.id, value.label, ...value.aliases].join(" ").toLowerCase().includes(query))) {
      const button = document.createElement("button"),
        label = language.id === "plaintext" ? this.t("codeBlocks.plainText") : language.label;
      button.type = "button";
      button.dataset.codeLanguageOption = language.id;
      button.setAttribute("role", "option");
      const active = codeLanguageIdentity(this.selected) === language.id;
      button.setAttribute("aria-selected", String(active));
      const text = document.createElement("span"),
        check = document.createElement("span");
      text.textContent = label;
      check.textContent = active ? "✓" : "";
      check.setAttribute("aria-hidden", "true");
      button.append(text, check);
      this.list.append(button);
    }
    if (!this.list.childElementCount) {
      const empty = document.createElement("p");
      empty.textContent = this.t("codeBlocks.noLanguages");
      this.list.append(empty);
    }
  }
  open(anchor: HTMLElement, value: string, choose: (language: string) => void) {
    if (!this.menu.hidden && this.anchor === anchor) return this.hide(true);
    this.hide();
    this.anchor = anchor;
    this.selected = value;
    this.choose = choose;
    this.search.value = "";
    this.render();
    anchor.setAttribute("aria-expanded", "true");
    if (matchMedia("(max-width: 700px)").matches) {
      Object.assign(this.menu.style, {
        left: "12px",
        right: "12px",
        width: "auto",
        top: "calc(var(--app-viewport-top, 0px) + var(--app-viewport-height, 100dvh) - max(12px, env(safe-area-inset-bottom)))",
        bottom: "auto",
        transform: "translateY(-100%)",
        maxWidth: "none",
        maxHeight: "min(calc(var(--app-viewport-height, 100dvh) - 24px), 480px)",
      });
      this.menu.hidden = false;
    } else {
      this.menu.removeAttribute("style");
      placeDocumentPopover(
        this.menu,
        anchor.getBoundingClientRect(),
        this.surface.closest(".document-canvas")?.getBoundingClientRect() ?? this.surface.getBoundingClientRect(),
      );
    }
    this.search.focus({ preventScroll: true });
  }
  hide(restore = false) {
    this.menu.hidden = true;
    this.anchor?.setAttribute("aria-expanded", "false");
    if (restore && this.anchor?.isConnected) this.anchor.focus({ preventScroll: true });
    this.anchor = null;
    this.choose = null;
  }
  detach(anchor: HTMLElement) {
    if (this.anchor === anchor) this.hide();
  }
  close() {
    this.hide();
    this.listeners.abort();
    this.menu.remove();
  }
}
