export function trackMobileViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  /** @type {number[]} */
  let settling = [];
  function editing() {
    const input = document.activeElement;
    if (input instanceof HTMLTextAreaElement) return !input.readOnly;
    if (input instanceof HTMLInputElement)
      return (
        !input.readOnly &&
        !["button", "checkbox", "radio", "submit", "reset", "file", "hidden", "color", "range"].includes(input.type)
      );
    return (
      input instanceof HTMLElement &&
      (input.isContentEditable || input instanceof HTMLIFrameElement || input instanceof HTMLSelectElement)
    );
  }
  function revealHomeComposer() {
    const input = document.activeElement;
    if (!(input instanceof HTMLTextAreaElement)) return;
    const composer = input.closest(".composer, .message-composer"),
      scroller = input.closest(".workbench-view, .creation-entry-layout .conversation");
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
    const conversation =
        ["new", "task", "creation"].includes(document.body.dataset.workbenchPage || "") ||
        (document.body.classList.contains("session-layout") &&
          !document.body.classList.contains("creation-entry-layout")),
      pinned = active && (editing() || conversation);
    root.classList.toggle("soft-keyboard-open", Boolean(pinned && innerHeight - viewport.height > 110));
    root.classList.toggle("visual-viewport-active", Boolean(active));
    // A dismissed WebKit keyboard can leave stale visual metrics during SPA navigation.
    // Entry/list pages use native dynamic viewport units when unfocused. Conversations
    // retain their keyboard-sized dock while focus moves into its menus and dialogs.
    if (pinned) {
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
  new MutationObserver((changes) => {
    if (changes.some((change) => change.oldValue !== document.body.dataset.workbenchPage)) settle();
  }).observe(document.body, { attributes: true, attributeFilter: ["data-workbench-page"], attributeOldValue: true });
  settle();
}
