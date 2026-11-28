import type {
  ApplicationToolCall,
  ApplicationToolDefinition,
  ApplicationToolResult,
} from "../../../shared/engine/application-tools.js";
import type { CreationExecution, CreationTaskSpec } from "../contracts.js";
import type { CreationInputSnapshot } from "../input.js";
import type { HarnessRuntimeView } from "../../../shared/harness/contracts.js";
import type { HarnessCreationCapabilities } from "../../../shared/creation/media-executors.js";

interface ScopedCreationRendering {
  definitions: readonly ApplicationToolDefinition[];
  call(call: ApplicationToolCall): Promise<ApplicationToolResult>;
}

/** Renderers receive one application-owned task and the current execution fence, never a model-selected owner. */
export interface CreationRendering {
  available(): Promise<readonly import("../../../shared/creation/contracts.js").CreationOutputType[]>;
  nativeImage?(owner: string, runtimeId: string, model: string): Promise<boolean>;
  capabilities?(owner: string, runtime: HarnessRuntimeView): Promise<HarnessCreationCapabilities>;
  open(context: {
    task: CreationTaskSpec;
    input: CreationInputSnapshot;
    signal: AbortSignal;
    readNativeFile?(filename: string): Promise<Buffer>;
    execution(call: ApplicationToolCall): CreationExecution;
    active(call: ApplicationToolCall): Promise<void>;
    assert(call: ApplicationToolCall): Promise<CreationExecution>;
  }): ScopedCreationRendering | Promise<ScopedCreationRendering>;
}
