import { setMessageHtml } from "../i18n.js";
import { setConversationContent } from "./content.js";
import { requireElement } from "../dom.js";
import { agentMessageText, renderAssistantMarkdown, renderItemImages } from "../rendering.js";

// Owns this element type; identity, transactions and lifecycle belong to the caller.
/** @param {Pick<import("./types.js").ConversationRendererServices, "turnFramesPort" | "identityPort" | "timingPort">} services */
export function createAssistantMessageRenderer({ turnFramesPort, identityPort, timingPort }) {
  return {
    id: "assistant-message",
    types: ["agentMessage"],
    /** @param {import("./types.js").ConversationRenderContext} context */
    render({ item, turnId, root, element }) {
      let el = element;
      if (!el) {
        el = document.createElement("div");
        setMessageHtml(el, '<div class="message-text"></div>');
      }
      const timeline = turnFramesPort.ensureTurnTimeline(turnId, root),
        body = requireElement(".message-text", el),
        text = agentMessageText(item, body.dataset.raw ?? ""),
        cwd = identityPort.imageCwd(item),
        receivedTimestamp =
          item.receivedAt ??
          item.completedAt ??
          (item.phase === "final_answer" ? timeline.dataset.turnCompletedAt : null) ??
          el.dataset.messageTimestamp ??
          Date.now() / 1000;
      el.dataset.messageTimestamp = String(timingPort.timestampSeconds(receivedTimestamp) || Date.now() / 1000);
      timingPort.setMessageTime(el, el.dataset.messageTimestamp, "Received at {time}");
      identityPort.placeAgentMessage(el, item, timeline);
      body.dataset.raw = text;
      setConversationContent(
        body,
        renderAssistantMarkdown(text, { cwd }) +
          renderItemImages(item, { cwd, className: "message-image-grid structured-message-images", excludeText: text }),
      );
      timingPort.syncWorkedForDivider(turnId);

      return el;
    },
  };
}
