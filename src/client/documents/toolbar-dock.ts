/** Docking changes only presentation; native sticky retains the toolbar's space and editor identity. */
export class DocumentToolbarDock {
  private observer: IntersectionObserver | null = null;
  private marker: HTMLElement | null;
  constructor(private slot: HTMLElement) {
    const previous = slot.previousElementSibling;
    this.marker = previous instanceof HTMLElement && previous.matches(".document-toolbar-marker") ? previous : null;
    const canvas = slot.closest<HTMLElement>(".document-canvas");
    if (this.marker && canvas) {
      this.observer = new IntersectionObserver(
        ([entry]) => {
          if (entry) slot.dataset.docked = String(!slot.hidden && !entry.isIntersecting);
        },
        { root: canvas, rootMargin: "-8px 0px 0px 0px", threshold: 0 },
      );
      this.observer.observe(this.marker);
    }
  }
  setVisible(visible: boolean) {
    this.slot.hidden = !visible;
    if (this.marker) this.marker.hidden = !visible;
    if (!visible) this.slot.dataset.docked = "false";
  }
  close() {
    this.observer?.disconnect();
    this.observer = null;
    this.setVisible(false);
    delete this.slot.dataset.docked;
  }
}
