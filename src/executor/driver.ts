import type { BuildExecution, BuildArtifact } from "../shared/builds/contracts.js";
import type { ExecutionInput } from "../shared/builds/resources.js";

export interface ExecutionDriver {
  ready?(): Promise<void>;
  run(
    id: string,
    input: ExecutionInput,
    signal: AbortSignal,
    update: (change: Partial<BuildExecution>) => void,
    logs: (text: string) => void,
  ): Promise<BuildArtifact>;
  cleanup(id: string): Promise<void>;
}
