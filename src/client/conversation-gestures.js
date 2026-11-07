// Tracks interaction lifetime only. The viewport owns reading intent and scroll writes.
/** @param {HTMLElement} root @param {{onDirection: (direction: number) => void; onIdle: () => void}} callbacks */
export function createConversationGestures(root, { onDirection, onIdle }) {
  let touchY = null,
    pointer = null,
    direction = 0,
    timer = 0;
  let releaseTouchTarget = () => {};
  const active = () => touchY !== null || pointer !== null || timer !== 0;
  function settle() {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      if (touchY !== null || pointer !== null) return;
      direction = 0;
      onIdle();
    }, 160);
  }
  function reset() {
    releaseTouchTarget();
    clearTimeout(timer);
    timer = 0;
    touchY = pointer = null;
    direction = 0;
  }
  function input(event, delta) {
    if (!delta) return;
    // Nested code and tool output keep their own scrolling gestures.
    for (let node = event.target; node instanceof Element && node !== root; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight + 1) continue;
      const style = getComputedStyle(node);
      if (!/auto|scroll/.test(style.overflowY)) continue;
      if (
        (delta < 0 && node.scrollTop > 0) ||
        (delta > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) ||
        /contain|none/.test(style.overscrollBehaviorY)
      )
        return;
    }
    direction = Math.sign(delta);
    onDirection(direction);
    settle();
  }
  function bind() {
    root.addEventListener("wheel", (event) => input(event, event.deltaY), { passive: true });
    root.addEventListener(
      "pointerdown",
      (event) => {
        pointer = event.pointerId;
      },
      { passive: true },
    );
    const endPointer = (event) => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      settle();
    };
    window.addEventListener("pointerup", endPointer, true);
    window.addEventListener("pointercancel", endPointer, true);
    const endTouch = (event) => {
      if (touchY === null || (event.type === "touchend" && event.touches.length)) return;
      touchY = null;
      releaseTouchTarget();
      settle();
    };
    root.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length !== 1) return;
        touchY = event.touches[0].clientY;
        releaseTouchTarget();
        const target = event.target;
        // Touch events keep their original target even after a streamed paragraph
        // is replaced. Listen there too, since detached events cannot reach window.
        target?.addEventListener("touchend", endTouch);
        target?.addEventListener("touchcancel", endTouch);
        releaseTouchTarget = () => {
          target?.removeEventListener("touchend", endTouch);
          target?.removeEventListener("touchcancel", endTouch);
          releaseTouchTarget = () => {};
        };
      },
      { passive: true },
    );
    root.addEventListener(
      "touchmove",
      (event) => {
        if (touchY === null || event.touches.length !== 1) return;
        const next = event.touches[0].clientY,
          delta = touchY - next;
        if (Math.abs(delta) > 2) {
          input(event, delta);
          touchY = next;
        }
      },
      { passive: true },
    );
    window.addEventListener("touchend", endTouch, { capture: true, passive: true });
    window.addEventListener("touchcancel", endTouch, { capture: true, passive: true });
    root.addEventListener("keydown", (event) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]"))
        return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) input(event, -1);
      else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) input(event, 1);
    });
    window.addEventListener("blur", () => {
      reset();
      onIdle();
    });
  }
  return {
    bind,
    reset,
    get active() {
      return active();
    },
    get direction() {
      return direction;
    },
    observeScroll() {
      if (active()) settle();
    },
  };
}
