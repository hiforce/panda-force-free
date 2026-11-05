// Owns scroll-follow intent and scroll controls independently of history loading.
export function assembleViewport({ $ }) {
  let conversationAutoScroll = true;
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
    conversationAutoScroll = conversationNearBottom(root);
    syncConversationScrollSurface();
  }
  function scrollBottom({ force = false } = {}) {
    requestAnimationFrame(() => {
      const root = $("#conversation");
      if (!root || (!force && !conversationAutoScroll)) return;
      root.scrollTop = root.scrollHeight;
      conversationAutoScroll = true;
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
    $("#conversation").addEventListener("scroll", (...args) => handleConversationScroll(...args), {
      passive: true,
    });
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
