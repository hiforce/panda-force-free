import { agentMessageText } from "../rendering.js";
import { composerInputKey } from "../composer-attachments.js";

// Reconciles message aliases from native and rollout sources within a turn.
export function assembleIdentity({ mutations, deliveryPort, state }) {
  function userMessageIdFamily(id) {
    return String(id).startsWith("local-") ? "local" : String(id).startsWith("host-user-") ? "rollout" : "app";
  }
  function claimEquivalentUserMessage(item, root, turnId) {
    const family = userMessageIdFamily(item.id);
    if (family === "local") return null;
    for (const [id, node] of state.items) {
      if (
        userMessageIdFamily(id) === "local" ||
        userMessageIdFamily(id) === family ||
        !root.contains(node) ||
        node.dataset.userTurnId !== turnId ||
        (item.clientId
          ? node.dataset.clientId !== item.clientId
          : node.dataset.inputKey !== composerInputKey(item.content))
      )
        continue;
      // Each source can claim a message once, so repeated identical steers stay distinct.
      if ([...state.items].some(([alias, element]) => element === node && userMessageIdFamily(alias) === family))
        continue;
      mutations.collection("items").set(item.id, node);
      return node;
    }
    return null;
  }
  function agentMessageIdFamily(id) {
    const value = String(id || "");
    return /^item[-_]/.test(value) ? "app" : /^(?:msg_|host-message-)/.test(value) ? "rollout" : "";
  }
  function claimEquivalentAgentMessage(item, turnId) {
    const family = agentMessageIdFamily(item.id);
    if (!family) return null;
    const text = agentMessageText(item, ""),
      commentary = item.phase === "commentary";
    for (const [id, node] of state.items) {
      if (agentMessageIdFamily(id) === family || node.closest("[data-turn-id]")?.dataset.turnId !== turnId) continue;
      const body = node.querySelector(".message-text"),
        existingCommentary = node.dataset.localConversationCommentary !== undefined;
      if (existingCommentary === commentary && body?.dataset.raw === text) {
        mutations.collection("items").set(item.id, node);
        return node;
      }
    }
    return null;
  }
  function placeAgentMessage(el, item, timeline) {
    const commentary = item.phase === "commentary",
      slot = timeline.querySelector(commentary ? ".turn-event-stream" : ".turn-final-slot");
    el.className = commentary ? "assistant-response assistant-commentary" : "assistant-response";
    if (commentary) {
      delete el.dataset.localConversationFinalAssistant;
      el.dataset.localConversationCommentary = "";
    } else {
      delete el.dataset.localConversationCommentary;
      el.dataset.localConversationFinalAssistant = "";
    }
    if (el.parentElement !== slot) slot.append(el);
  }
  function imageCwd(item = {}) {
    return item.cwd || state.active?.cwd || state.config.defaultCwd || ".";
  }
  function claimOptimisticUser(item, root, turnId) {
    if (String(item.id).startsWith("local-")) return null;
    const message = deliveryPort
      .pendingMessages()
      .find(
        (message) =>
          message.owner === deliveryPort.pendingMessageOwner() &&
          message.delivery !== "failed" &&
          (item.clientId
            ? item.clientId === message.id
            : composerInputKey(message.content) === composerInputKey(item.content)) &&
          !message.excludedTurns.includes(turnId) &&
          (message.turnId === "optimistic" || message.turnId === turnId),
      );
    let el = message && state.items.get(message.id);
    if (message) {
      deliveryPort.confirmMessage(message);
      // A rebuilt history may discard the optimistic node; the native item recreates it.
    }
    if (!el) {
      const candidates = [...root.querySelectorAll('.user-turn[data-optimistic-user="true"]')];
      el = candidates.find((node) => {
        const pending = deliveryPort.pendingMessages().find((message) => state.items.get(message.id) === node);
        return (
          !pending &&
          (node.dataset.steer !== "true" || node.dataset.userTurnId === turnId) &&
          node.dataset.inputKey === composerInputKey(item.content)
        );
      });
    }
    if (!el) return null;
    for (const [id, node] of state.items) if (node === el) mutations.collection("items").delete(id);
    delete el.dataset.optimisticUser;
    mutations.collection("items").set(item.id, el);
    return el;
  }
  return {
    claimOptimisticUser,
    imageCwd,

    claimEquivalentUserMessage,
    claimEquivalentAgentMessage,
    placeAgentMessage,
  };
}
