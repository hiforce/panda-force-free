// Interactive message roots opt into reuse across same-session history projections.
// Their owner retains the node, listeners, draft and in-flight response together.
export const CONVERSATION_INTERACTION = "data-conversation-interaction";

/** @param {Element} node */
export function isConversationInteraction(node) {
  return node.hasAttribute(CONVERSATION_INTERACTION);
}

/** @param {HTMLElement} root */
export function retainInteractionFocus(root) {
  const focused = document.activeElement;
  const retained =
    focused instanceof HTMLElement && root.contains(focused) && focused.closest(`[${CONVERSATION_INTERACTION}]`);
  return () => {
    if (retained && root.contains(focused)) focused.focus({ preventScroll: true });
  };
}

// Only destructive history projections wait for interaction to end. Live deltas
// continue immediately; newer snapshots replace queued work instead of replaying it.
/** @param {() => boolean} interacting */
export function createHistoryProjectionBoundary(interacting) {
  /** @type {(() => void) | null} */
  let pending = null;
  /** @type {{ promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null} */
  let completion = null;
  function flush() {
    if (interacting() || !pending) return;
    const render = pending,
      done = completion;
    pending = completion = null;
    try {
      render();
      done?.resolve();
    } catch (error) {
      done?.reject(error);
    }
  }
  return {
    /** @param {() => void} render */
    render(render) {
      pending = render;
      if (!completion) {
        let resolve = () => {},
          reject = (_error) => {};
        const promise = new Promise(
          /** @param {(value?: void) => void} accept */ (accept, decline) => {
            resolve = () => accept();
            reject = decline;
          },
        );
        completion = { promise, resolve, reject };
      }
      const promise = completion.promise;
      flush();
      return promise;
    },
    flush,
    cancel() {
      pending = null;
      completion?.resolve();
      completion = null;
    },
  };
}
