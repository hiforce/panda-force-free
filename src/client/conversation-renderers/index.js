import { createConversationRendererRegistry } from "./registry.js";
import { createUserMessageRenderer } from "./user-message.js";
import { createAssistantMessageRenderer } from "./assistant-message.js";
import { createGeneratedImageRenderer } from "./generated-image.js";
import { createQuestionRenderer } from "./question.js";
import { createActivityMessageRenderer } from "./activity-message.js";
import { createViewedImageRenderer } from "./viewed-image.js";

// This is the only registration list for built-in conversation elements.
/** @param {import("./types.js").ConversationRendererServices} services */
export function createBuiltinConversationRenderers({
  state,
  mutations,
  turnFramesPort,
  activityPort,
  submissionPort,
  timingPort,
  viewUpdates,
  t,
  queuePort,
  identityPort,
  clipboardPort,
  reviewPort,
  sideTasksPort,
}) {
  return createConversationRendererRegistry([
    createQuestionRenderer({
      state,
      mutations,
      turnFramesPort,
      activityPort,
      submissionPort,
      timingPort,
      viewUpdates,
      t,
    }),
    createUserMessageRenderer({ state, turnFramesPort, queuePort, timingPort, identityPort, clipboardPort, t }),
    createAssistantMessageRenderer({ turnFramesPort, identityPort, timingPort }),
    createGeneratedImageRenderer({ turnFramesPort, identityPort }),
    createViewedImageRenderer({ turnFramesPort, activityPort }),
    createActivityMessageRenderer({ activityPort, mutations, reviewPort, viewUpdates, sideTasksPort }),
  ]);
}
