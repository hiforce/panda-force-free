// Owns submission locks, pending message identity and optimistic reconciliation.
/** @param {import("./ports.js").FeatureOptions<"selection" | "viewUpdates" | "state" | "$", never, "delivery">} options */
export function assembleDelivery({ selection, viewUpdates, state, $ }) {
  const promptSubmissions = new Map();
  const pendingUserMessages = new Map();
  let localUserSequence = 0;
  function releasePromptSubmission(token) {
    if (token) for (const [key, value] of promptSubmissions) if (value === token) promptSubmissions.delete(key);
    viewUpdates.request("composerSubmit");
  }
  function pendingMessageOwner() {
    return state.active?.id || `new:${selection.current}`;
  }
  function renderPendingUserMessages() {
    for (const message of pendingUserMessages.values())
      if (message.owner === pendingMessageOwner())
        viewUpdates.request("item", { item: message, turnId: message.turnId, root: $("#conversation"), live: false });
  }
  function setPendingMessageDelivery(id, delivery) {
    const message = pendingUserMessages.get(id);
    if (!message) return;
    message.delivery = delivery;
    if (message.owner === pendingMessageOwner()) viewUpdates.request("item", { item: message, turnId: message.turnId });
  }

  return {
    pendingMessages: () => Object.freeze([...pendingUserMessages.values()]),
    confirmMessage(message) {
      releasePromptSubmission(message.submissionToken);
      pendingUserMessages.delete(message.id);
    },
    isSending: (owner) => promptSubmissions.has(owner),
    lock: (owner, token) => {
      promptSubmissions.set(owner, token);
    },
    lockIfFree: (owner, token) => {
      if (!promptSubmissions.has(owner)) promptSubmissions.set(owner, token);
    },
    nextMessageId: (prefix) => `${prefix}-${Date.now()}-${++localUserSequence}`,
    track: (message) => {
      pendingUserMessages.set(message.id, message);
    },
    hasMessage: (id) => pendingUserMessages.has(id),
    renderPendingUserMessages,

    pendingMessageOwner,
    releasePromptSubmission,

    setPendingMessageDelivery,
  };
}
