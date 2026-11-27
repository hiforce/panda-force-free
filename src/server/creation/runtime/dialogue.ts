import { CreationError } from "../contracts.js";
import { creationRecord, creationText } from "../validation.js";
import type { ApplicationToolDefinition, ApplicationToolResult } from "../../../shared/engine/application-tools.js";
import { stableJson } from "../../../shared/stable-json.js";

const name = "panda_creation_turn";
const chooseAfterClarification =
  'Use the answer to resolve the original request. If the user requested a deliverable, call panda_creation_turn with {"action":"deliver"}, read current context, then create or save the requested artifact. For a conversational answer, call panda_creation_turn with action reply.';
export const creationDialogueInstructions =
  "Choose what to do with the latest user message before rendering or saving. " +
  "For a question, a request for explanation, or feedback that does not clearly ask for a change, " +
  "answer directly with panda_creation_turn action reply. If the answer depends on a saved result, " +
  "read the relevant authorized context or original first. Preserve any previously saved result. " +
  "If an essential detail or the requested change is ambiguous, use action clarify with one focused question. " +
  chooseAfterClarification +
  " When the user clearly requests an artifact or revision and no clarification is needed, use action deliver and read current context before rendering or saving. " +
  "Output-type, rendering and saving instructions below apply only to action deliver. " +
  "After action reply, stop. The application displays the reply text as the final answer.";

const tool: ApplicationToolDefinition = {
  name,
  description: "Reply to the user, ask for an essential missing detail, or begin an explicitly requested deliverable.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["reply", "clarify", "deliver"] },
      text: { type: "string", maxLength: 6000 },
    },
  },
};

export function creationDialogue(enabled: boolean) {
  let delivery = !enabled;
  let reply: string | undefined;
  let asking = false;
  const delivering = () => delivery && !asking;
  return {
    definitions: enabled ? [tool] : [],
    handles: (method: string) => enabled && method === name,
    delivering,
    answer: () => reply,
    blockedDelivery(): ApplicationToolResult | undefined {
      if (delivering()) return;
      return {
        success: false,
        text: stableJson({
          error: "deliveryRequired",
          retryable: reply === undefined,
          action: reply
            ? "A conversational reply was already recorded. End this turn."
            : asking
              ? "Wait for the pending answer, then follow the clarification result."
              : chooseAfterClarification,
        }),
      };
    },
    async call(input: unknown, ask: (question: string) => Promise<unknown>): Promise<ApplicationToolResult> {
      const { action, text } = creationRecord(input, ["action", "text"]);
      if (reply || asking) throw new CreationError("conflict");
      if (action === "deliver" && (text === undefined || text === "")) {
        delivery = true;
        return { success: true, text: "Deliverable authorized for this turn. Read current context before writing." };
      }
      if (action === "reply") {
        reply = creationText(text, 6000);
        delivery = false;
        return { success: true, text: "Reply recorded. End this turn." };
      }
      if (action !== "clarify") throw new CreationError("invalidInput");
      const question = creationText(text, 1000);
      delivery = false;
      asking = true;
      try {
        return { success: true, text: stableJson({ answers: await ask(question), next: chooseAfterClarification }) };
      } finally {
        asking = false;
      }
    },
  };
}
