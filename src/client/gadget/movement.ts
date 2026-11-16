import type { GadgetLayout, GadgetManifest } from "../../shared/gadget/contracts.js";
import { settleGadgetLayout } from "../../shared/gadget/layout.js";
export function bindGadgetMovement(options: {
  root: HTMLElement;
  editing(): boolean;
  mobile(): boolean;
  layout(): GadgetLayout;
  manifest(id: string): GadgetManifest | undefined;
  change(run: (l: GadgetLayout) => void): void;
  add(id: string, x: number, y: number): void;
  render(): void;
}) {
  const { root } = options;
  let drag: { id?: string; type?: string } | null = null,
    resize: {
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      cw: number;
      rh: number;
      pointer: number;
      handle: HTMLElement;
    } | null = null;
  const canvas = () => root.querySelector<HTMLElement>(".gadget-canvas")!;
  const position = (event: DragEvent) => {
    const c = canvas(),
      r = c.getBoundingClientRect(),
      gap = parseFloat(getComputedStyle(c).gap) || 14,
      cw = (r.width + gap) / 12,
      rh = 22 + gap,
      i = drag?.id ? options.layout().items.find((i) => i.id === drag!.id) : null,
      m = drag?.type ? options.manifest(drag.type) : null,
      w = i?.w ?? m!.layout.w,
      h = i?.h ?? m!.layout.h;
    return {
      x: Math.max(0, Math.min(12 - w, Math.floor((event.clientX - r.left) / cw))),
      y: Math.max(0, Math.floor((event.clientY - r.top) / rh)),
      w,
      h,
      cw,
      rh,
      gap,
    };
  };
  const cleanup = () => {
    drag = null;
    root.querySelector(".gadget-drop-target")?.remove();
    root.querySelectorAll(".dragging").forEach((e) => e.classList.remove("dragging"));
  };
  const start = (event: DragEvent) => {
    if (!options.editing() || options.mobile()) return;
    const el =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-gadget-handle],[data-gadget-type]")
        : null;
    if (!el) return;
    drag = el.dataset.gadgetType ? { type: el.dataset.gadgetType } : { id: el.dataset.gadgetHandle };
    event.dataTransfer?.setData("text/plain", JSON.stringify(drag));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };
  const over = (event: DragEvent) => {
    if (!drag || !(event.target instanceof Element) || !event.target.closest(".gadget-canvas")) return;
    event.preventDefault();
    const p = position(event),
      ghost = root.querySelector<HTMLElement>(".gadget-drop-target") ?? document.createElement("div");
    ghost.className = "gadget-drop-target";
    Object.assign(ghost.style, {
      left: p.x * p.cw + "px",
      top: p.y * p.rh + "px",
      width: p.w * p.cw - p.gap + "px",
      height: p.h * p.rh - p.gap + "px",
    });
    canvas().append(ghost);
  };
  const drop = (event: DragEvent) => {
    if (!drag || !(event.target instanceof Element) || !event.target.closest(".gadget-canvas")) return;
    event.preventDefault();
    const target = drag,
      p = position(event);
    cleanup();
    if (target.type) options.add(target.type, p.x, p.y);
    else
      options.change((l) => {
        const i = l.items.find((i) => i.id === target.id)!;
        i.x = p.x;
        i.y = p.y;
        settleGadgetLayout(l.items, i);
      });
  };
  const key = (event: KeyboardEvent) => {
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-gadget-handle]") : null;
    if (!options.editing() || !el || !event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const id = el.dataset.gadgetHandle!;
    options.change((l) => {
      const i = l.items.find((i) => i.id === id)!,
        m = options.manifest(i.gadget);
      if (options.mobile()) {
        const n = l.mobileOrder.indexOf(id),
          b = Math.max(0, Math.min(l.mobileOrder.length - 1, n + (event.key === "ArrowUp" ? -1 : 1)));
        [l.mobileOrder[n], l.mobileOrder[b]] = [l.mobileOrder[b]!, l.mobileOrder[n]!];
        return;
      }
      if (event.shiftKey) {
        if (event.key === "ArrowRight") i.w = Math.min(12 - i.x, i.w + 1);
        if (event.key === "ArrowLeft") i.w = Math.max(m?.layout.minW ?? 1, i.w - 1);
        if (event.key === "ArrowUp") i.h = Math.max(m?.layout.minH ?? 4, i.h - 1);
        if (event.key === "ArrowDown") i.h = Math.min(24, i.h + 1);
      } else {
        if (event.key === "ArrowRight") i.x = Math.min(12 - i.w, i.x + 1);
        if (event.key === "ArrowLeft") i.x = Math.max(0, i.x - 1);
        if (event.key === "ArrowUp") i.y = Math.max(0, i.y - 1);
        if (event.key === "ArrowDown") i.y++;
      }
      settleGadgetLayout(l.items, i);
    });
    root.querySelector<HTMLElement>(`[data-gadget-handle="${CSS.escape(id)}"]`)?.focus();
  };
  const down = (event: PointerEvent) => {
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-gadget-resize]") : null;
    if (!el || !options.editing() || options.mobile()) return;
    event.preventDefault();
    const i = options.layout().items.find((i) => i.id === el.dataset.gadgetResize)!,
      c = canvas(),
      gap = parseFloat(getComputedStyle(c).gap) || 14;
    resize = {
      id: i.id,
      x: event.clientX,
      y: event.clientY,
      w: i.w,
      h: i.h,
      cw: (c.clientWidth + gap) / 12,
      rh: 22 + gap,
      pointer: event.pointerId,
      handle: el,
    };
    el.setPointerCapture(event.pointerId);
  };
  const dims = (event: PointerEvent) => {
    const i = options.layout().items.find((i) => i.id === resize!.id)!,
      m = options.manifest(i.gadget);
    return {
      w: Math.max(
        m?.layout.minW ?? 1,
        Math.min(12 - i.x, resize!.w + Math.round((event.clientX - resize!.x) / resize!.cw)),
      ),
      h: Math.max(m?.layout.minH ?? 4, Math.min(24, resize!.h + Math.round((event.clientY - resize!.y) / resize!.rh))),
    };
  };
  const move = (event: PointerEvent) => {
    if (!resize) return;
    const d = dims(event),
      el = root.querySelector<HTMLElement>(`[data-gadget-instance="${CSS.escape(resize.id)}"]`);
    el?.style.setProperty("--gadget-w", String(d.w));
    el?.style.setProperty("--gadget-h", String(d.h));
  };
  const finish = (event?: PointerEvent) => {
    if (!resize) return;
    const old = resize,
      d = event ? dims(event) : null;
    resize = null;
    try {
      old.handle.releasePointerCapture(old.pointer);
    } catch {}
    if (d)
      options.change((l) => {
        const i = l.items.find((i) => i.id === old.id)!;
        i.w = d.w;
        i.h = d.h;
        settleGadgetLayout(l.items, i);
      });
    else options.render();
  };
  root.addEventListener("dragstart", start);
  root.addEventListener("dragover", over);
  root.addEventListener("drop", drop);
  root.addEventListener("dragend", cleanup);
  root.addEventListener("keydown", key);
  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  const up = (e: PointerEvent) => finish(e),
    cancel = () => finish();
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  return () => {
    cleanup();
    finish();
    root.removeEventListener("dragstart", start);
    root.removeEventListener("dragover", over);
    root.removeEventListener("drop", drop);
    root.removeEventListener("dragend", cleanup);
    root.removeEventListener("keydown", key);
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", up);
    root.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
  };
}
