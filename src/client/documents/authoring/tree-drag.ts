import type { DocumentTreeTarget } from "../../../shared/documents/navigation.js";
import type { DocumentTreeIndex } from "./tree-model.js";

interface DragState {
  id: string;
  pointer: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  active: boolean;
  target: DocumentTreeTarget | null;
  hover: string;
  hoverAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  version: number;
}
/** Pointer capture, hit testing and scrolling stay independent from API, source editing and persistence. */
export class DocumentTreeDrag {
  private state: DragState | null = null;
  private frame: number | null = null;
  private listeners = new AbortController();
  private suppressClick = false;
  constructor(
    private host: HTMLElement,
    private index: () => DocumentTreeIndex,
    private enabled: () => boolean,
    private expand: (id: string) => void,
    private commit: (id: string, target: DocumentTreeTarget) => void,
  ) {
    const { signal } = this.listeners;
    host.addEventListener("pointerdown", (event) => this.down(event), { signal });
    host.addEventListener(
      "click",
      (event) => {
        if (this.suppressClick) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.suppressClick = false;
        }
      },
      { signal, capture: true },
    );
    document.addEventListener("pointermove", (event) => this.move(event), { signal, passive: false });
    document.addEventListener("pointerup", (event) => this.up(event), { signal });
    document.addEventListener("pointercancel", () => this.cancel(), { signal });
    host.addEventListener(
      "lostpointercapture",
      () => {
        if (this.state) this.cancel();
      },
      { signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") this.cancel();
      },
      { signal },
    );
    window.addEventListener("blur", () => this.cancel(), { signal });
  }
  private down(event: PointerEvent) {
    const handle = (event.target as Element).closest<HTMLElement>(
        event.pointerType === "mouse" ? ".document-tree-handle,.document-tree-title" : ".document-tree-handle",
      ),
      row = handle?.closest<HTMLElement>("[data-tree-id]");
    if (!handle || !row || !this.enabled() || event.button !== 0 || !event.isPrimary) return;
    this.cancel();
    this.suppressClick = false;
    const state: DragState = {
      id: row.dataset.treeId!,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target: null,
      hover: "",
      hoverAt: 0,
      timer: null,
      version: this.index().tree.version,
    };
    this.state = state;
    if (event.pointerType !== "mouse") state.timer = setTimeout(() => this.activate(), 280);
  }
  private activate() {
    if (!this.state || !this.enabled()) return;
    this.state.active = true;
    this.suppressClick = true;
    this.host.setPointerCapture(this.state.pointer);
    this.host.classList.add("tree-dragging");
    this.host.setAttribute("aria-busy", "true");
    this.tick();
  }
  private move(event: PointerEvent) {
    const state = this.state;
    if (!state || state.pointer !== event.pointerId) return;
    state.x = event.clientX;
    state.y = event.clientY;
    if (!state.active && Math.hypot(state.x - state.startX, state.y - state.startY) > 6) {
      if (state.timer) {
        this.cancel();
        return;
      }
      this.activate();
    }
    if (state.active) {
      event.preventDefault();
      this.hit();
    }
  }
  private hit() {
    const state = this.state;
    if (!state?.active) return;
    if (this.index().tree.version !== state.version || !this.enabled()) {
      this.cancel();
      return;
    }
    this.host.querySelectorAll("[data-drop]").forEach((node) => node.removeAttribute("data-drop"));
    const element = document.elementFromPoint(state.x, state.y),
      row = element?.closest<HTMLElement>("[data-tree-id]"),
      root = element?.closest<HTMLElement>("[data-tree-root]");
    let target: DocumentTreeTarget | null = null;
    if (row && this.host.contains(row)) {
      const bounds = row.getBoundingClientRect(),
        ratio = (state.y - bounds.top) / bounds.height;
      target = { kind: ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside", documentId: row.dataset.treeId! };
    } else if (root && this.host.contains(root)) target = { kind: "root" };
    if (target && !this.index().canMove(state.id, target)) target = null;
    state.target = target;
    if (target) {
      (row || root)?.setAttribute("data-drop", target.kind);
    }
    const hovering = target?.kind === "inside" ? target.documentId : "";
    if (hovering !== state.hover) {
      state.hover = hovering;
      state.hoverAt = performance.now();
    }
    if (hovering && performance.now() - state.hoverAt > 650) {
      this.expand(hovering);
      state.hoverAt = performance.now() + 100000;
    }
  }
  private tick() {
    if (!this.state?.active) return;
    const box = this.host.getBoundingClientRect(),
      y = this.state.y;
    if (y >= box.top - 24 && y <= box.bottom + 24) {
      const speed =
        y < box.top + 44
          ? -Math.ceil((box.top + 44 - y) / 5)
          : y > box.bottom - 44
            ? Math.ceil((y - box.bottom + 44) / 5)
            : 0;
      if (speed) this.host.scrollTop += Math.max(-16, Math.min(16, speed));
    }
    this.hit();
    if (this.state?.active) this.frame = requestAnimationFrame(() => this.tick());
  }
  private up(event: PointerEvent) {
    const state = this.state;
    if (!state || state.pointer !== event.pointerId) return;
    if (state.active) this.hit();
    if (this.state !== state) return;
    const target = state.active ? state.target : null,
      id = state.id;
    this.cancel();
    this.suppressClick = state.active;
    if (target) this.commit(id, target);
    // A drag suppresses only its own synthetic click, not the next unrelated menu click.
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  }
  cancel() {
    const state = this.state;
    this.state = null;
    this.suppressClick = false;
    if (state?.timer) clearTimeout(state.timer);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (state && this.host.hasPointerCapture(state.pointer)) this.host.releasePointerCapture(state.pointer);
    this.host.classList.remove("tree-dragging");
    this.host.removeAttribute("aria-busy");
    this.host.querySelectorAll("[data-drop]").forEach((node) => node.removeAttribute("data-drop"));
  }
  destroy() {
    this.cancel();
    this.listeners.abort();
  }
}
