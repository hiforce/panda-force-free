// Owns this element type; identity, transactions and lifecycle belong to the caller.
/** @param {Pick<import("./types.js").ConversationRendererServices, "activityPort" | "mutations" | "reviewPort" | "viewUpdates" | "sideTasksPort">} services */
export function createActivityMessageRenderer({ activityPort, mutations, reviewPort, viewUpdates, sideTasksPort }) {
  return {
    id: "activity-message",
    itemRoot: false,
    types: [
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "collabAgentToolCall",
      "subAgentActivity",
      "webSearch",
      "reasoning",
      "plan",
    ],
    /** @param {import("./types.js").ConversationRenderContext} context */
    render({ item, turnId, root }) {
      const id = activityPort.activityItemId(item);
      const el = activityPort.ensureActivity(turnId, root, id, item.type === "reasoning");
      activityPort.addActivity(item, el, id);
      if (item.type === "fileChange") {
        for (const ch of item.changes || []) {
          const path = ch.path || ch.filePath || "Changed file";
          mutations.collection("changes").set(path, ch);
        }
        reviewPort.syncTurnReviewFromItems(turnId);
        viewUpdates.request("review");
      }
      if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") sideTasksPort.updateSideTasks(item);

      return el;
    },
  };
}
