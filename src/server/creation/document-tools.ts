import type {
  ApplicationToolCall,
  ApplicationToolDefinition,
  ApplicationToolResult,
  ApplicationRunScope,
} from "../../shared/engine/application-tools.js";
import { stableJson } from "../../shared/stable-json.js";
import { CreationError, type CreationExecution, type CreationLease } from "./contracts.js";
import type { CreationExecutionTasks } from "./ports.js";
import type { CreationOutputs } from "./outputs.js";

export const CREATE_DOCUMENT_TOOL = "panda_documents_create";
const definition: ApplicationToolDefinition = {
  name: CREATE_DOCUMENT_TOOL,
  description:
    "Save the task's primary document through the application. The result is the actual saved document receipt. Call only once; a retry returns the same document. Project, parent and permission are application-owned. Body is {schema:1,format:'richtext',document:{type:'doc',content:[...]}}. Supported blocks include paragraph, heading, lists, blockquote, codeBlock and table. Text nodes use {type:'text',text:'...'}. Do not provide HTML, external images, file paths, publication commands or operational fields.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "object", description: "Canonical editable rich document source." },
    },
  },
};

/** Engine-neutral tool dispatch owns one task slot, never arbitrary project paths or document replacement. */
export function documentCreationTools(
  value: CreationLease,
  tasks: CreationExecutionTasks,
  outputs: Pick<CreationOutputs, "invoke">,
  now: () => number = Date.now,
) {
  const lease = { ...value };
  let execution: CreationExecution | null = null;
  return {
    definitions: [structuredClone(definition)],
    started(scope: ApplicationRunScope) {
      const bound = tasks.bind(lease, scope.sessionId, scope.runId, now());
      if (bound instanceof Promise) return bound.then((value) => (execution = value));
      execution = bound;
      return execution;
    },
    async call(call: ApplicationToolCall): Promise<ApplicationToolResult> {
      const bound = execution;
      if (
        !bound ||
        call.name !== CREATE_DOCUMENT_TOOL ||
        call.sessionId !== bound.sessionId ||
        call.runId !== bound.runId
      )
        throw new CreationError("leaseLost");
      const current = await tasks.get(lease.owner, lease.taskId);
      if (current.generation !== bound.generation || current.cancelRequested) throw new CreationError("leaseLost");
      // A completed result is read-only. Native retries in the same live run never submit new document text.
      const saved = current.artifact ? current : await outputs.invoke(bound, call.arguments);
      if (!saved.artifact) throw new CreationError("unavailable");
      return { success: true, text: stableJson(saved.artifact) };
    },
  };
}
