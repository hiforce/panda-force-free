import { createConversationViewport } from "../conversation-viewport.js";

/** @param {import("./ports.js").FeatureOptions<"$", never, "viewport">} options */
export function assembleViewport({ $ }) {
  return createConversationViewport($("#conversation"), $("#conversationScrollBottom"));
}
