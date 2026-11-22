import { CreationError } from "../contracts.js";
import { creationRecord, creationText } from "../validation.js";
import type { ApplicationToolDefinition, ApplicationToolResult } from "../../../shared/engine/application-tools.js";

const name = "panda_creation_turn";
export const creationDialogueInstructions =
  "Choose what to do with the latest user message before rendering or saving. " +
  "For a question, a request for explanation, or feedback that does not clearly ask for a change, " +
  "answer directly with panda_creation_turn action reply. If the answer depends on a saved result, " +
  "read the relevant authorized context or original first. Preserve any previously saved result. " +
  "If an essential detail or the requested change is ambiguous, use action clarify with one focused question. " +
  "Use the answer and continue in this conversation. When the user clearly requests an artifact or revision " +
  "and the requirements are sufficient, read current context and use action deliver before rendering or saving. " +
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
  return {
    definitions: enabled ? [tool] : [],
    handles: (method: string) => enabled && method === name,
    delivering: () => delivery && !asking,
    answer: () => reply,
    async call(input: unknown, ask: (question: string) => Promise<unknown>): Promise<ApplicationToolResult> {
      const { action, text } = creationRecord(input, ["action", "text"]);
      if (reply || asking) throw new CreationError("conflict");
      if (action === "deliver" && text === undefined) {
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
        return { success: true, text: JSON.stringify(await ask(question)) };
      } finally {
        asking = false;
      }
    },
  };
}
