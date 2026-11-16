/** Title measurements run outside ResizeObserver delivery; one mounted editor owns every pending frame. */
export class DocumentTitleLayout {
  private host: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private frame: number | null = null;
  value = "";
  mount(host: HTMLElement) {
    this.close();
    this.host = host;
    this.resize();
    let width = host.clientWidth;
    this.observer = new ResizeObserver(() => {
      if (width === host.clientWidth) return;
      width = host.clientWidth;
      if (this.frame !== null) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (this.host === host) this.resize();
      });
    });
    this.observer.observe(host);
  }
  resize() {
    const title = this.host?.querySelector<HTMLTextAreaElement>("textarea#documentTitle");
    if (!title) return;
    this.value = title.value;
    title.style.height = "auto";
    title.style.height = title.scrollHeight + "px";
  }
  close() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.host = null;
    this.value = "";
  }
}
