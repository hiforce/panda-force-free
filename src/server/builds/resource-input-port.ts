import type { ResourceBuildRequest } from "../../shared/builds/resources.js";
import type { BuildRun, BuildRunChanges } from "../../shared/builds/run.js";

export interface ResourceInputReservation<Job extends BuildRun> {
  job: Job;
  ready: boolean;
  reservedBytes: number;
}
export interface ResourceInputLedger<Job extends BuildRun> {
  get(id: string): Job;
  update(id: string, changes: BuildRunChanges): Job;
  accept(id: string, inputHash: string, bytes: number): Job;
  pending(): ResourceInputReservation<Job>[];
  cleanup(): Job[];
  released(id: string): void;
}

export interface BuildInputBudget {
  acquire(bytes: number): { release(): void } | null;
}
export interface ResourceBuildInputs {
  prepare(id: string): void;
  write(id: string, input: ResourceBuildRequest): Promise<number>;
  with<T>(id: string, digest: string, use: (input: ResourceBuildRequest, bytes: number) => Promise<T>): Promise<T>;
  remove(id: string): Promise<void>;
}
