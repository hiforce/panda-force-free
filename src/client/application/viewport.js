// Owns scroll-follow intent and scroll controls independently of history loading.
/** @param {import("./ports.js").FeatureOptions<"$", never, "viewport">} options */
export function assembleViewport({ $ }) {
  let conversationAutoScroll = true;
  let lastScrollTop = 0,
    frame = 0,
    forced = false;
  function conversationNearBottom(root = $("#conversation")) {
    return !root || root.scrollHeight - root.scrollTop - root.clientHeight < 80;
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
    syncConversationScrollSurface();
  }
  function scrollBottom({ force = false } = {}) {
    forced ||= force;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const follow = forced || conversationAutoScroll;
      forced = false;
      const root = $("#conversation");
      if (!root) return;
      if (follow) {
        root.scrollTop = root.scrollHeight;
        lastScrollTop = root.scrollTop;
        conversationAutoScroll = true;
      }
      syncConversationScrollSurface();
    });
  }
  function scrollOpenedThreadToBottom() {
    conversationAutoScroll = true;
    scrollBottom({ force: true });
    requestAnimationFrame(() => scrollBottom({ force: true }));
  }
  function resetAutoScroll() {
    conversationAutoScroll = true;
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
  };
}
