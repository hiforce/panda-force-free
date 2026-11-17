import type { CreationTaskSpec } from "./contracts.js";

/** Only the application chooses persistent execution directories; attachment or skill text cannot grant paths. */
export interface CreationWorkspace {
  readonly path: string;
  readonly conversationId: string;
  verify(): Promise<void>;
}
export interface CreationWorkspaces {
  open(task: CreationTaskSpec): Promise<CreationWorkspace>;
  lookup(owner: string, taskId: string): Promise<CreationWorkspace | null>;
}
