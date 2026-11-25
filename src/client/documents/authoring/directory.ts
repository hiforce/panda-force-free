/** The mobile directory alone owns its modal focus boundary and editor inert state. */
export class AuthoringDirectory {
  readonly mobile = matchMedia("(max-width:700px)");
  constructor(
    private root: HTMLElement,
    private changed: () => void,
  ) {
    this.mobile.addEventListener("change", () => {
      this.set(false);
      this.changed();
    });
    root.addEventListener("keydown", (event) => {
      if (event.isComposing || !this.mobile.matches || !root.classList.contains("directory-open")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.set(false, true);
      }
      if (event.key !== "Tab") return;
      const nodes = [
        ...root.querySelectorAll<HTMLElement>('#authoringDirectory :is(button,input,summary,a,[tabindex="0"])'),
      ].filter((node) => !node.matches(":disabled") && node.getClientRects().length);
      const edge = event.shiftKey ? nodes[0] : nodes.at(-1),
        next = event.shiftKey ? nodes.at(-1) : nodes[0];
      if (document.activeElement === edge) {
        event.preventDefault();
        next?.focus();
      }
    });
  }
  set(open: boolean, restore = false) {
    this.root.classList.toggle("directory-open", open);
    const aside = this.root.querySelector<HTMLElement>("#authoringDirectory"),
      surface = this.root.querySelector<HTMLElement>(".personal-library-surface, #documentEditor");
    if (surface) surface.inert = open && this.mobile.matches;
    if (aside) {
      if (open && this.mobile.matches) {
        aside.setAttribute("role", "dialog");
        aside.setAttribute("aria-modal", "true");
      } else {
        aside.removeAttribute("role");
        aside.removeAttribute("aria-modal");
      }
    }
    this.root
      .querySelectorAll('[data-authoring-action="directory"]')
      .forEach((button) => button.setAttribute("aria-expanded", String(open)));
    if (open && this.mobile.matches)
      this.root
        .querySelector<HTMLButtonElement>('[data-authoring-action="directory-dismiss"]')
        ?.focus({ preventScroll: true });
    else if (restore) {
      const trigger = [
        ...this.root.querySelectorAll<HTMLElement>(
          '[data-authoring-action="reader-directory"], [data-authoring-action="directory"], .document-editor-more > summary',
        ),
      ].find((node) => node.getClientRects().length);
      trigger?.focus({ preventScroll: true });
    }
  }
  toggle() {
    this.set(!this.root.classList.contains("directory-open"));
  }
}
