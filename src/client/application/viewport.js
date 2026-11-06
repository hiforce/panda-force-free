// Owns scroll-follow intent and scroll controls independently of history loading.
/** @param {import("./ports.js").FeatureOptions<"$", never, "viewport">} options */
export function assembleViewport({ $ }) {
  let conversationAutoScroll = true;
  let lastScrollTop = 0,
    frame = 0,
    forced = false;
  /** @type {{node: Element; selector: string; offset: number; top: number} | null} */
  let readingPosition = null;
  function conversationNearBottom(root = $("#conversation")) {
    return !root || root.scrollHeight - root.scrollTop - root.clientHeight < 2;
  }
  function followLatest(root = $("#conversation")) {
    root.scrollTop = root.scrollHeight;
    lastScrollTop = root.scrollTop;
    conversationAutoScroll = true;
    readingPosition = null;
  }
  function captureReadingPosition(root = $("#conversation")) {
    const bounds = root.getBoundingClientRect();
    for (const attribute of ["data-item-id", "data-turn-id", "data-user-turn-id"]) {
      for (const node of root.querySelectorAll(`[${attribute}]`)) {
        const rect = node.getBoundingClientRect();
        if (rect.height && rect.bottom > bounds.top && rect.top < bounds.bottom)
          return {
            node,
            selector: `[${attribute}="${CSS.escape(node.getAttribute(attribute) || "")}"]`,
            offset: rect.top - bounds.top,
            top: root.scrollTop,
          };
      }
    }
    return null;
  }
  function restoreReadingPosition(root = $("#conversation")) {
    if (!readingPosition) return;
    const { node, selector, offset, top } = readingPosition;
    const anchor = root.contains(node) ? node : root.querySelector(selector);
    // WebKit does not preserve an anchor when a history snapshot replaces the DOM.
    root.scrollTop = anchor
      ? root.scrollTop + anchor.getBoundingClientRect().top - root.getBoundingClientRect().top - offset
      : top;
    lastScrollTop = root.scrollTop;
    readingPosition = captureReadingPosition(root);
  }
  /** @param {() => void} render */
  function preserveReadingPosition(render) {
    if (!forced && Math.abs($("#conversation").scrollTop - lastScrollTop) > 1) handleConversationScroll();
    if (!conversationAutoScroll && !forced) readingPosition = captureReadingPosition();
    try {
      render();
    } finally {
      if (!conversationAutoScroll && !forced) restoreReadingPosition();
      else followLatest();
    }
  }
  function syncConversationScrollSurface() {
    const root = $("#conversation"),
      button = $("#conversationScrollBottom");
    if (!root || !button) return;
    button.hidden = conversationNearBottom(root);
    button.setAttribute("aria-hidden", String(button.hidden));
  }
  function handleConversationScroll() {
    const root = $("#conversation");
    if (!root) return;
    if (conversationNearBottom(root)) conversationAutoScroll = true;
    else if (root.scrollTop < lastScrollTop - 1) conversationAutoScroll = false;
    lastScrollTop = root.scrollTop;
    readingPosition = conversationAutoScroll ? null : captureReadingPosition(root);
    syncConversationScrollSurface();
  }
  function scrollBottom({ force = false } = {}) {
    forced ||= force;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const root = $("#conversation");
      if (!root) return;
      // A touch/scrollbar move may arrive before its deferred scroll event.
      if (!forced && Math.abs(root.scrollTop - lastScrollTop) > 1) handleConversationScroll();
      const follow = forced || conversationAutoScroll;
      forced = false;
      if (follow) followLatest(root);
      else restoreReadingPosition(root);
      syncConversationScrollSurface();
    });
  }
  function scrollOpenedThreadToBottom() {
    forced = false;
    followLatest();
    scrollBottom();
  }
  function resetAutoScroll() {
    conversationAutoScroll = true;
    readingPosition = null;
  }
  function bind() {
    const root = $("#conversation");
    // Images, fonts and layout changes can finish after the message's render frame.
    // Observe turn containers without treating their growth as user scroll intent.
    const sizes = new ResizeObserver(() => scrollBottom());
    sizes.observe(root);
    for (const child of root.children) sizes.observe(child);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node instanceof Element) sizes.unobserve(node);
        for (const node of record.addedNodes) if (node instanceof Element) sizes.observe(node);
      }
      scrollBottom();
    }).observe(root, { childList: true });
    $("#conversation").addEventListener(
      "scroll",
      /** @param {Parameters<typeof handleConversationScroll>} args */ (...args) => handleConversationScroll(...args),
      {
        passive: true,
      },
    );
    $("#conversationScrollBottom").onclick = () => {
      resetAutoScroll();
      scrollBottom({ force: true });
    };
  }
  return {
    bind,
    scrollBottom,
    resetAutoScroll,
    syncConversationScrollSurface,
    scrollOpenedThreadToBottom,
    preserveReadingPosition,
  };
}
