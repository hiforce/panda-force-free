import type {
  ApplicationToolCall,
  ApplicationToolDefinition,
  ApplicationToolResult,
} from "../../../shared/engine/application-tools.js";
import type { CreationExecution, CreationTaskSpec } from "../contracts.js";
import type { CreationInputSnapshot } from "../input.js";

/** Renderers receive one application-owned task and the current execution fence, never a model-selected owner. */
export interface CreationRendering {
  available(): Promise<readonly import("../../../shared/creation/contracts.js").CreationOutputType[]>;
  open(context: {
    task: CreationTaskSpec;
    input: CreationInputSnapshot;
    signal: AbortSignal;
    execution(call: ApplicationToolCall): CreationExecution;
    active(call: ApplicationToolCall): Promise<void>;
    assert(call: ApplicationToolCall): Promise<CreationExecution>;
  }): {
    definitions: readonly ApplicationToolDefinition[];
    call(call: ApplicationToolCall): Promise<ApplicationToolResult>;
  };
}
