import { CreationSkillCategories } from "./skill-categories.js";
import type { Translate } from "../../shared/i18n/messages.js";
import type { CreationSkillSelection } from "../../shared/creation/contracts.js";
import { setMessageHtml } from "../i18n.js";
import { coverFailed } from "../templates/covers.js";
import { creationSkillBrowserFrame, creationSkillOptions, type CreationSkillEntry } from "./skill-views.js";

interface BrowserSnapshot {
  entries: readonly CreationSkillEntry[];
  selected: readonly CreationSkillSelection[];
  loading: boolean;
  failed: boolean;
  more: boolean;
}
/** Owns the picker layer, focus and browsing position; the creation controller owns selected versions. */
export class CreationSkillBrowser {
  private readonly dialog = document.createElement("dialog");
  private readonly search: HTMLInputElement;
  private readonly scroll: HTMLElement;
  private readonly options: HTMLElement;
  private readonly categories: CreationSkillCategories;
  private query = "";
  private trigger: HTMLElement | null = null;
  private parent: HTMLDialogElement | null = null;
  private position = 0;
  private snapshot: BrowserSnapshot | null = null;
  private readonly syncViewport = () => {
    const viewport = window.visualViewport;
    if (this.open && window.matchMedia("(max-width: 700px)").matches && viewport) {
      this.dialog.style.setProperty("--skill-browser-height", `${viewport.height}px`);
      this.dialog.style.setProperty("--skill-browser-top", `${viewport.offsetTop}px`);
    } else {
      this.dialog.style.removeProperty("--skill-browser-height");
      this.dialog.style.removeProperty("--skill-browser-top");
    }
  };
  constructor(
    private readonly t: Translate,
    action: (button: HTMLButtonElement) => void,
    private readonly beforeClose: () => void,
  ) {
    const title = "creation-skill-browser-" + crypto.randomUUID();
    this.dialog.className = "workbench-dialog creation-skill-browser";
    this.dialog.setAttribute("aria-labelledby", title);
    setMessageHtml(this.dialog, creationSkillBrowserFrame(t, title));
    this.search = this.dialog.querySelector<HTMLInputElement>("[data-skill-search]")!;
    this.scroll = this.dialog.querySelector<HTMLElement>(".creation-skill-browser-scroll")!;
    this.options = this.dialog.querySelector<HTMLElement>(".creation-skill-options")!;
    this.categories = new CreationSkillCategories(
      this.dialog.querySelector<HTMLElement>("[data-skill-categories]")!,
      t,
      (reset) => {
        if (reset) this.scroll.scrollTop = 0;
        if (this.open) this.render();
      },
    );
    this.search.oninput = () => {
      if (this.query === this.search.value) return;
      this.query = this.search.value;
      this.scroll.scrollTop = 0;
      this.render();
    };
    this.dialog.onclick = (event) => {
      const target = event.target as Element;
      if (target.closest("[data-skill-browser-close]")) this.close();
      else {
        const button = target.closest<HTMLButtonElement>("[data-skill-action]");
        if (button && !button.disabled) action(button);
      }
    };
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    this.dialog.addEventListener("error", coverFailed, true);
    window.addEventListener("resize", this.syncViewport);
    window.visualViewport?.addEventListener("resize", this.syncViewport);
    window.visualViewport?.addEventListener("scroll", this.syncViewport);
  }
  get open() {
    return this.dialog.open;
  }
  show(trigger: HTMLElement) {
    this.trigger = trigger;
    this.parent = trigger.closest("dialog");
    if (!this.dialog.isConnected) document.body.append(this.dialog);
    if (this.dialog.open) return;
    const touch = window.matchMedia("(pointer: coarse), (max-width: 767px)").matches;
    const close = this.dialog.querySelector<HTMLButtonElement>("[data-skill-browser-close]")!;
    close.autofocus = touch;
    this.search.autofocus = !touch;
    // iOS keeps a textarea focused when a toolbar button is tapped. Do this in the opening gesture.
    if (touch && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    this.dialog.showModal();
    this.syncViewport();
    this.render();
    (touch ? close : this.search).focus({
      preventScroll: true,
    });
    this.scroll.scrollTop = this.position;
    this.categories.refresh();
  }
  reset() {
    this.close(false);
    this.query = "";
    this.search.value = "";
    this.position = 0;
    this.scroll.scrollTop = 0;
    this.categories.reset();
  }
  update(snapshot: BrowserSnapshot) {
    this.snapshot = snapshot;
    if (this.open) this.render();
  }
  private render() {
    if (!this.snapshot) return;
    const { entries, selected, loading, failed, more } = this.snapshot,
      focused = this.dialog.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null,
      skill = focused?.dataset.skillKey,
      action = focused?.dataset.skillAction,
      top = this.scroll.scrollTop;
    setMessageHtml(
      this.options,
      failed && !entries.length
        ? ""
        : creationSkillOptions(this.t, entries, selected, this.query, loading, (entry) =>
            this.categories.matches(entry),
          ),
    );
    this.options.setAttribute("aria-busy", String(loading));
    const error = this.dialog.querySelector<HTMLElement>("[data-skill-browser-error]")!,
      next = this.dialog.querySelector<HTMLButtonElement>('[data-skill-action="more"]')!,
      count = this.dialog.querySelector<HTMLElement>("[data-skill-browser-count]")!;
    error.hidden = !failed;
    error.textContent = failed ? this.t("creation.skillLoadFailed") : "";
    next.hidden = !more && !failed;
    next.disabled = loading;
    next.textContent = this.t(loading ? "creation.loadingSkill" : failed ? "common.retry" : "creation.moreSkills");
    const summary = this.t("creation.selectedCount", { count: selected.length });
    if (count.textContent !== summary) count.textContent = summary;
    if (skill && action)
      this.options
        .querySelector<HTMLElement>(`[data-skill-key="${CSS.escape(skill)}"][data-skill-action="${action}"]`)
        ?.focus({ preventScroll: true });
    this.scroll.scrollTop = top;
  }
  close(restore = true) {
    this.beforeClose();
    if (!this.open) return;
    this.position = this.scroll.scrollTop;
    this.dialog.close();
    this.syncViewport();
    const target = this.trigger?.isConnected
      ? this.trigger
      : this.parent?.querySelector<HTMLElement>("[data-skill-browser-open]");
    if (restore) target?.focus({ preventScroll: true });
  }
  dispose() {
    this.close(false);
    this.categories.dispose();
    this.dialog.removeEventListener("error", coverFailed, true);
    window.removeEventListener("resize", this.syncViewport);
    window.visualViewport?.removeEventListener("resize", this.syncViewport);
    window.visualViewport?.removeEventListener("scroll", this.syncViewport);
    this.dialog.remove();
  }
}
