import { createHistoryProjectionBoundary } from "./conversation-interactions.js";
import { createConversationGestures } from "./conversation-gestures.js";
import { captureConversationAnchor, conversationAnchorTop } from "./conversation-scroll-anchor.js";

// Owns follow intent, user gestures and scroll writes independently of rendering.
/** @param {HTMLElement} root @param {HTMLButtonElement | null} button */
export function createConversationViewport(root, button = null) {
  let mode = "conversation";
  let following = true,
    frame = 0,
    forced = false,
    renderDepth = 0;
  const gestures = createConversationGestures(root, {
    onDirection(direction) {
      if (direction < 0 && measure().top > 0) {
        following = false;
        forced = false;
        anchor = captureConversationAnchor(root);
      }
    },
    onIdle() {
      historyProjection.flush();
      scrollBottom();
    },
  });
  const historyProjection = createHistoryProjectionBoundary(() => gestures.active);
  /** @type {ReturnType<typeof captureConversationAnchor>} */
  let anchor = null;
  const events = new AbortController();
  /** @type {ResizeObserver | undefined} */
  let sizes;
  /** @type {MutationObserver | undefined} */
  let mutations;
  const measure = () => {
    const height = root.scrollHeight,
      view = root.clientHeight;
    // Elastic overscroll must not turn a bottom bounce into an upward gesture.
    return { top: Math.max(0, Math.min(root.scrollTop, height - view)), height, view };
  };
  let last = measure();
  const nearBottom = (position = measure()) => position.height - position.view - position.top < 2;

  function syncConversationScrollSurface() {
    if (!button) return;
    button.hidden = mode === "discovery" || nearBottom();
    button.setAttribute("aria-hidden", String(button.hidden));
  }
  function observeScroll() {
    const next = measure(),
      delta = next.top - last.top,
      layoutChanged = next.height !== last.height || next.view !== last.view;
    // WebKit clamps scrollTop when content shrinks. A later append must not turn
    // that layout correction into an upward gesture and disable following.
    // Small compositor steps accumulate into real reading movement. Dropping
    // each one preserves an obsolete anchor that the next output pulls back to.
    if (delta !== 0 && (Math.sign(delta) === gestures.direction || !layoutChanged)) {
      if (delta < 0) following = false;
      else if (nearBottom(next) || (gestures.direction > 0 && next.top >= last.height - last.view - 2))
        following = true;
      anchor = following ? null : captureConversationAnchor(root);
      gestures.observeScroll();
    }
    last = next;
    syncConversationScrollSurface();
  }
  function applyPosition(rendered = false) {
    if (mode === "discovery") {
      syncConversationScrollSurface();
      return;
    }
    if (!root.clientHeight) return;
    if (!rendered) observeScroll();
    // Never fight touch momentum with a scheduled write, including zero-distance
    // writes. A synchronous history replacement still restores its visible anchor.
    if (!forced && gestures.active && !rendered) return;
    if (forced) {
      following = true;
      anchor = null;
    }
    forced = false;
    const target = following ? root.scrollHeight - root.clientHeight : anchor && conversationAnchorTop(root, anchor);
    if (target !== null && Math.abs(target - root.scrollTop) > 1) root.scrollTop = target;
    last = measure();
    anchor = following ? null : captureConversationAnchor(root);
    syncConversationScrollSurface();
  }
  /** @param {() => void} render @param {{follow?: boolean}} options */
  function preserveReadingPosition(render, { follow = true } = {}) {
    const before = measure();
    if (!renderDepth++) {
      observeScroll();
      if (!follow) {
        following = false;
        anchor = captureConversationAnchor(root);
      }
      if (!following && !anchor) anchor = captureConversationAnchor(root);
    }
    try {
      render();
    } finally {
      if (!--renderDepth) {
        if (gestures.active && following && !forced) {
          const after = measure();
          // A render can briefly empty the scroller and clamp it to zero. Repair
          // that loss without chasing new output or treating it as finger input.
          if (after.top < before.top) root.scrollTop = Math.min(before.top, after.height - after.view);
          last = measure();
          syncConversationScrollSurface();
        } else applyPosition(true);
      }
    }
  }
  function scrollBottom({ force = false } = {}) {
    forced ||= force;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      applyPosition();
    });
  }
  function resetAutoScroll({ discardHistory = true } = {}) {
    following = true;
    anchor = null;
    gestures.reset();
    if (discardHistory) historyProjection.cancel();
    last = measure();
  }
  function scrollOpenedThreadToBottom() {
    resetAutoScroll();
    forced = true;
    applyPosition();
    scrollBottom();
  }
  function bind() {
    last = measure();
    gestures.bind();
    root.addEventListener("scroll", observeScroll, { passive: true, signal: events.signal });
    const observer = new ResizeObserver(() => scrollBottom());
    sizes = observer;
    observer.observe(root);
    for (const child of root.children) observer.observe(child);
    mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node instanceof Element) observer.unobserve(node);
        for (const node of record.addedNodes) if (node instanceof Element) observer.observe(node);
      }
      scrollBottom();
    });
    mutations.observe(root, { childList: true });
    if (button)
      button.onclick = () => {
        resetAutoScroll({ discardHistory: false });
        historyProjection.flush();
        scrollBottom({ force: true });
      };
  }
  return {
    /** @param {"conversation" | "discovery"} value */
    setConversationMode(value) {
      if (mode === value) return;
      mode = value;
      resetAutoScroll();
      if (mode === "discovery") root.scrollTop = 0;
      syncConversationScrollSurface();
    },
    bind,
    dispose() {
      events.abort();
      gestures.dispose();
      sizes?.disconnect();
      mutations?.disconnect();
      cancelAnimationFrame(frame);
      frame = 0;
      historyProjection.cancel();
      if (button) button.onclick = null;
    },
    scrollBottom,
    resetAutoScroll,
    syncConversationScrollSurface,
    scrollOpenedThreadToBottom,
    preserveReadingPosition,
    renderHistoryWhenIdle: (render) => historyProjection.render(render),
  };
}
