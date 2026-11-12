import { requireElement } from "../dom.js";

// Standalone viewed images retain their loaded media across same-session history projections.
/** @param {Pick<import("./types.js").ConversationRendererServices, "activityPort" | "turnFramesPort">} services */
export function createViewedImageRenderer({ activityPort, turnFramesPort }) {
  return {
    id: "viewed-image",
    types: ["imageView"],
    /** @param {import("./types.js").ConversationRenderContext} context */
    render({ item, turnId, root, element }) {
      const id = activityPort.activityItemId(item);
      if (element && !root.contains(element))
        requireElement(".turn-event-stream", turnFramesPort.ensureTurnTimeline(turnId, root)).append(element);
      const group = element || activityPort.ensureActivity(turnId, root, id, true);
      activityPort.addActivity(item, group, id);
      return group;
    },
  };
}
