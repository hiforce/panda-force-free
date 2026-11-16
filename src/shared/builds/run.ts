import type { BuildEngine, BuildExecution } from "./contracts.js";

/** Execution state is independent of the document space or template sample that requested it. */
export interface BuildRun {
  id: string;
  engine: BuildEngine;
  inputHash: string;
  phase: BuildExecution["phase"] | "collecting" | "cancelling" | "cancelled";
  createdAt: number;
  updatedAt: number;
  error: string | null;
  connection: "ready" | "retrying";
  outputBytes: number;
  fileCount: number;
  artifactAvailable: boolean;
  image: BuildExecution["image"] | null;
}

export const terminalBuildRun = (run: BuildRun) => ["completed", "failed", "cancelled"].includes(run.phase);

/** A monitor can update execution fields, never change the caller's ownership or frozen input identity. */
export type BuildRunChanges = Partial<
  Pick<BuildRun, "phase" | "connection" | "error" | "image" | "outputBytes" | "fileCount" | "artifactAvailable">
>;
