import { findElement, findElements } from "../dom.js";
import { localizeAttribute } from "../i18n.js";
import { storage, STORAGE_KEYS } from "../storage.js";

/** The shell stylesheet owns width bounds; drag updates only its shared token. */
export function createSidebarResize(t) {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const min = Number.parseFloat(styles.getPropertyValue("--workspace-sidebar-min-width"));
  const max = Number.parseFloat(styles.getPropertyValue("--workspace-sidebar-max-width"));
  const initial = Number.parseFloat(styles.getPropertyValue("--workspace-sidebar-default-width"));
  const contentMin = Number.parseFloat(styles.getPropertyValue("--workspace-content-min-width"));
  const handles = findElements(".workspace-sidebar-resizer");
  if (![min, max, initial, contentMin].every(Number.isFinite) || min > initial || initial > max)
    return { bind() {}, reset() {} };
  const desktop = matchMedia("(min-width: 768px)");
  const clamp = (value) => Math.round(Math.max(min, Math.min(max, Number.isFinite(value) ? value : initial)));
  const saved = storage.get(STORAGE_KEYS.sidebarWidth);
  let preference = saved === null ? initial : clamp(Number(saved));
  let width = preference;
  let queuedFrame = 0;
  let drag = /** @type {{handle: HTMLElement; id: number; x: number; width: number} | null} */ (null);
  let bound = false;
  function contextHandle() {
    return handles.find((handle) => handle.closest("dialog[open]")) || handles[0];
  }
  function availableMax(handle) {
    const frame = handle?.closest(".settings-card") || findElement("#app");
    const size = frame?.clientWidth || 0;
    if (!frame || !size) return max;
    const columns = getComputedStyle(frame).gridTemplateColumns.match(/[\d.]+px/g) || [];
    const right = columns.length === 3 ? Number.parseFloat(columns[2]) : 0;
    return Math.max(min, Math.min(max, size - right - contentMin));
  }
  function apply(value, persist = false, handle = contextHandle()) {
    width = Math.min(clamp(value), Math.floor(availableMax(handle)));
    const css = `${width}px`;
    const changed = root.style.getPropertyValue("--workspace-sidebar-width") !== css;
    if (changed) root.style.setProperty("--workspace-sidebar-width", css);
    for (const handle of handles) {
      const limit = String(Math.floor(availableMax(handle)));
      if (handle.getAttribute("aria-valuemax") !== limit) handle.setAttribute("aria-valuemax", limit);
      if (handle.getAttribute("aria-valuenow") !== String(width)) {
        handle.setAttribute("aria-valuenow", String(width));
        localizeAttribute(handle, "aria-valuetext", "shell.sidebarWidthValue", { width }, t);
      }
    }
    if (persist) {
      preference = width;
      storage.set(STORAGE_KEYS.sidebarWidth, String(preference));
    }
    if (changed) dispatchEvent(new CustomEvent("panda-force:layout-changed"));
  }
  function finish(cancel = false) {
    const previous = drag;
    if (!previous) return;
    drag = null;
    document.body.classList.remove("sidebar-resizing");
    apply(cancel ? previous.width : width, !cancel && width !== previous.width, previous.handle);
    if (previous.handle.hasPointerCapture(previous.id)) previous.handle.releasePointerCapture(previous.id);
  }
  function reset() {
    preference = initial;
    storage.set(STORAGE_KEYS.sidebarWidth, String(initial));
    apply(initial);
  }
  function bind() {
    if (bound) return;
    bound = true;
    for (const handle of handles) {
      handle.dataset.ready = "true";
      handle.setAttribute("aria-valuemin", String(min));
      localizeAttribute(handle, "aria-label", "shell.resizeSidebar", undefined, t);
      localizeAttribute(handle, "title", "shell.resizeSidebarHint", undefined, t);
      handle.addEventListener("pointerdown", (event) => {
        if (!desktop.matches || event.button !== 0 || drag) return;
        event.preventDefault();
        drag = { handle, id: event.pointerId, x: event.clientX, width };
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add("sidebar-resizing");
      });
      handle.addEventListener("pointermove", (event) => {
        if (drag?.handle === handle && drag.id === event.pointerId)
          apply(drag.width + event.clientX - drag.x, false, handle);
      });
      handle.addEventListener("pointerup", (event) => {
        if (drag?.id === event.pointerId) finish();
      });
      handle.addEventListener("pointercancel", (event) => {
        if (drag?.id === event.pointerId) finish(true);
      });
      handle.addEventListener("lostpointercapture", (event) => {
        if (drag?.id === event.pointerId) finish();
      });
      handle.addEventListener("dblclick", reset);
      handle.addEventListener("keydown", (event) => {
        if (!desktop.matches) return;
        const next = { ArrowLeft: width - 8, ArrowRight: width + 8, Home: min, End: max }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        apply(next, true, handle);
      });
    }
    desktop.addEventListener("change", () => finish(true));
    addEventListener("blur", () => finish(true));
    const observer = new ResizeObserver(() => {
      if (!desktop.matches || drag || queuedFrame) return;
      queuedFrame = requestAnimationFrame(() => {
        queuedFrame = 0;
        if (!drag) apply(preference);
      });
    });
    for (const selector of ["#app", ".conversation-shell", "#settingsContent"]) {
      const element = findElement(selector);
      if (element) observer.observe(element);
    }
    apply(width);
  }
  return { bind, reset };
}
