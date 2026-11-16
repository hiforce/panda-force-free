import { engineQuestions, validateQuestionAnswers } from "../../../shared/engine/questions.js";
import type {
  ApplicationRunCallbacks,
  ApplicationRunScope,
  ApplicationToolDefinition,
} from "../../../shared/engine/application-tools.js";
import type { EngineEnvelope } from "../../../shared/engine/contracts.js";

/** Native request IDs never leave this adapter or enter the browser's conversation approval map. */
export function codexApplicationCalls(options: {
  tools: readonly ApplicationToolDefinition[];
  callbacks: ApplicationRunCallbacks;
  scope(): ApplicationRunScope | null;
  ready: Promise<void>;
  stopped(): boolean;
  respond(value: object): void;
}) {
  const names = new Set(options.tools.map((tool) => tool.name));
  let calls = 0;
  return async (message: EngineEnvelope): Promise<void> => {
    const reject = () =>
      options.respond({ id: message.id, error: { code: -32601, message: "Application tool unavailable" } });
    const params = message.params,
      initial = options.scope();
    if (!initial || !params || params.threadId !== initial.sessionId || options.stopped()) {
      reject();
      return;
    }
    try {
      await options.ready;
      const scope = options.scope();
      if (!scope || params.turnId !== scope.runId || options.stopped()) {
        reject();
        return;
      }
      if (message.method === "item/tool/call") {
        if (
          typeof params.tool !== "string" ||
          !names.has(params.tool) ||
          typeof params.callId !== "string" ||
          !params.callId ||
          params.callId.length > 128 ||
          ++calls > 32
        ) {
          reject();
          return;
        }
        const result = await options.callbacks.call({
          ...scope,
          name: params.tool,
          callId: params.callId,
          arguments: params.arguments,
        });
        if (typeof result.text !== "string" || result.text.length > 32768 || typeof result.success !== "boolean")
          throw new Error("Invalid application tool response");
        if (
          result.images &&
          (result.images.length > 2 ||
            result.images.some(
              (image) => !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 12000000,
            ))
        )
          throw new Error("Invalid application image response");
        options.respond({
          id: message.id,
          result: {
            success: result.success,
            contentItems: [
              { type: "inputText", text: result.text },
              ...(result.images ?? []).map((imageUrl) => ({ type: "inputImage", imageUrl })),
            ],
          },
        });
      } else if (message.method === "item/tool/requestUserInput" && options.callbacks.question) {
        const questions = engineQuestions(params.questions);
        if (questions.length > 8 || JSON.stringify(questions).length > 32768)
          throw new Error("Application question limit exceeded");
        const answers = await options.callbacks.question(scope, questions);
        validateQuestionAnswers(questions, { answers });
        options.respond({ id: message.id, result: { answers } });
      } else reject();
    } catch {
      // Paths, task records, prompts and credentials must not escape through model-visible exception text.
      if (message.method === "item/tool/call")
        options.respond({
          id: message.id,
          result: {
            success: false,
            contentItems: [{ type: "inputText", text: "The application rejected this operation." }],
          },
        });
      else reject();
    }
  };
}
