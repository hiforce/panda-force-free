import type { MessageId, Translate } from "../shared/i18n/messages.js";
import { getBrowserI18n, localizeAttribute, setMessageHtml } from "./i18n.js";
import { codexIcon } from "./codex-icons.js";

/** A manual carousel keeps native touch/trackpad scrolling, with mouse dragging and keyboard controls. */
export function createHorizontalCarousel(
  track: HTMLElement,
  t: Translate,
  labels: { region: MessageId; previous: MessageId; next: MessageId; kind: MessageId },
) {
  const controls = document.createElement("nav");
  controls.className = "horizontal-carousel-controls";
  localizeAttribute(controls, "aria-label", labels.region, {}, t);
  const previous = document.createElement("button"),
    next = document.createElement("button");
  for (const [button, label, icon] of [
    [previous, labels.previous, "chevronLeft"],
    [next, labels.next, "chevronRight"],
  ] as const) {
    button.type = "button";
    button.className = "icon-button small";
    localizeAttribute(button, "aria-label", label, {}, t);
    localizeAttribute(button, "title", label, {}, t);
    setMessageHtml(button, codexIcon(icon));
    controls.append(button);
  }
  track.classList.add("horizontal-carousel-track");
  track.tabIndex = 0;
  track.setAttribute("role", "region");
  localizeAttribute(track, "aria-label", labels.region, {}, t);
  track.setAttribute("aria-roledescription", t(labels.kind));
  const unsubscribe = getBrowserI18n().subscribe(() => track.setAttribute("aria-roledescription", t(labels.kind)));
  const behavior = () =>
    matchMedia("(prefers-reduced-motion: reduce)").matches ? ("instant" as const) : ("smooth" as const);
  const refresh = () => {
    const extent = Math.max(0, track.scrollWidth - track.clientWidth);
    controls.hidden = extent <= 1;
    previous.disabled = track.scrollLeft <= 1;
    next.disabled = track.scrollLeft >= extent - 1;
  };
  const step = (direction: number) => {
    const first = track.children[0]?.getBoundingClientRect(),
      second = track.children[1]?.getBoundingClientRect();
    const distance = first && second ? Math.abs(second.left - first.left) : track.clientWidth;
    track.scrollBy({ left: direction * distance, behavior: behavior() });
  };
  previous.onclick = () => step(-1);
  next.onclick = () => step(1);
  const keydown = (event: KeyboardEvent) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(event.target instanceof Element) ||
      event.target.closest("input,textarea,select,button")
    )
      return;
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!direction && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const children = Array.from(track.children).filter((node): node is HTMLElement => node instanceof HTMLElement);
    const current = children.findIndex((node) => node.contains(document.activeElement));
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? children.length - 1
          : Math.max(0, Math.min(children.length - 1, current + direction));
    if (current >= 0 || !direction) {
      const target = children[index];
      (target?.querySelector<HTMLElement>("a[href],button:not([disabled]),[tabindex]") || target)?.focus({
        preventScroll: true,
      });
      if (target)
        track.scrollBy({
          left: target.getBoundingClientRect().left - track.getBoundingClientRect().left,
          behavior: behavior(),
        });
    } else step(direction);
  };
  let drag: { id: number; x: number; left: number; moving: boolean } | undefined;
  let suppressUntil = 0;
  const down = (event: PointerEvent) => {
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button,input,textarea,select"))
    )
      return;
    drag = { id: event.pointerId, x: event.clientX, left: track.scrollLeft, moving: false };
  };
  const move = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (event.buttons !== 1) {
      drag = undefined;
      track.classList.remove("is-dragging");
      return;
    }
    if (!drag.moving && Math.abs(event.clientX - drag.x) < 6) return;
    if (!drag.moving) {
      drag.moving = true;
      track.setPointerCapture(event.pointerId);
      track.classList.add("is-dragging");
    }
    event.preventDefault();
    track.scrollLeft = drag.left + drag.x - event.clientX;
  };
  const up = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moving) {
      suppressUntil = Date.now() + 250;
      if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    }
    drag = undefined;
    track.classList.remove("is-dragging");
    refresh();
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const dragstart = (event: DragEvent) => event.preventDefault();
  track.addEventListener("scroll", refresh, { passive: true });
  track.addEventListener("keydown", keydown);
  track.addEventListener("pointerdown", down);
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
  track.addEventListener("click", click, true);
  track.addEventListener("dragstart", dragstart);
  const observer = new ResizeObserver(refresh);
  observer.observe(track);
  refresh();
  return {
    controls,
    refresh,
    dispose() {
      observer.disconnect();
      unsubscribe();
      track.removeEventListener("scroll", refresh);
      track.removeEventListener("keydown", keydown);
      track.removeEventListener("pointerdown", down);
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
      track.removeEventListener("pointercancel", up);
      track.removeEventListener("click", click, true);
      track.removeEventListener("dragstart", dragstart);
      track.classList.remove("horizontal-carousel-track", "is-dragging");
      controls.remove();
    },
  };
}
