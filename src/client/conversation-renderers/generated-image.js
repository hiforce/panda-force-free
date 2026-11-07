import { setMessageHtml } from "../i18n.js";
import { requireElement } from "../dom.js";
import { renderItemImages } from "../rendering.js";

// Owns this element type; identity, transactions and lifecycle belong to the caller.
/** @param {Pick<import("./types.js").ConversationRendererServices, "turnFramesPort" | "identityPort">} services */
export function createGeneratedImageRenderer({ turnFramesPort, identityPort }) {
  return {
    id: "generated-image",
    types: ["imageGeneration"],
    /** @param {import("./types.js").ConversationRenderContext} context */
    render({ item, turnId, root, element }) {
      let el = element;
      if (!el) {
        el = document.createElement("div");
        el.className = "assistant-generated-image";
        requireElement(".turn-event-stream", turnFramesPort.ensureTurnTimeline(turnId, root)).append(el);
      }
      const html = renderItemImages(item, {
        cwd: identityPort.imageCwd(item),
        className: "generated-image-grid",
        thumbnail: true,
      });
      setMessageHtml(
        el,
        html ||
          `<div class="generated-image-pending ${item.status === "inProgress" ? "loading-shimmer" : ""}">${item.status === "failed" ? "Image generation failed" : "Generating image"}</div>`,
      );

      return el;
    },
  };
}
