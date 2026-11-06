export function trackMobileViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  /** @type {number[]} */
  let settling = [];
  function revealHomeComposer() {
    const input = document.activeElement;
    if (!(input instanceof HTMLTextAreaElement)) return;
    const composer = input.closest(".composer"),
      scroller = input.closest(".workbench-view");
    if (!composer || !scroller) return;
    const bounds = composer.getBoundingClientRect(),
      visible = scroller.getBoundingClientRect();
    // The home composer is inline; session composers already own their bottom dock.
    if (bounds.bottom > visible.bottom - 12) scroller.scrollTop += bounds.bottom - visible.bottom + 12;
    else if (bounds.top < visible.top + 12 && bounds.height <= visible.height - 24)
      scroller.scrollTop -= visible.top + 12 - bounds.top;
  }
  const update = () => {
    frame = 0;
    const mobile = root.classList.contains("mobile-device") || matchMedia("(max-width:767px)").matches;
    // Keep native pinch zoom: only adapt the keyboard/browser-chrome viewport at normal scale.
    const active = mobile && viewport && Math.abs(viewport.scale - 1) < 0.02 && viewport.height > 0;
    root.classList.toggle("soft-keyboard-open", Boolean(active && innerHeight - viewport.height > 110));
    root.classList.toggle("visual-viewport-active", Boolean(active));
    if (active) {
      root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
      root.style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
      revealHomeComposer();
    } else {
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const cancelSettling = () => {
    for (const timer of settling) window.clearTimeout(timer);
    settling = [];
  };
  const settle = () => {
    cancelSettling();
    schedule();
    // WebKit may finish keyboard/browser-chrome animation after focus or pageshow,
    // without a final resize event. Resample briefly, never poll in the background.
    settling = [80, 240, 600].map((delay) => window.setTimeout(schedule, delay));
  };
  const suspend = () => {
    cancelSettling();
    cancelAnimationFrame(frame);
    frame = 0;
  };
  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", settle);
  window.addEventListener("pagehide", suspend);
  window.addEventListener("focus", settle);
  window.addEventListener("orientationchange", settle);
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") suspend();
    else settle();
  });
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  settle();
}
