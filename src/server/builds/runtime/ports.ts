import type { MetadataStore } from "../../../shared/async-value.js";
import type { BuildArtifact, BuildInput, BuildExecution } from "../../../shared/builds/contracts.js";
import type { BuildRun, BuildRunChanges } from "../../../shared/builds/run.js";

/** A caller owns persistence, authorization context, intent creation and its history lifecycle. */
export interface BuildRunStore {
  active(): BuildRun[];
  get(id: string): BuildRun;
  update(id: string, changes: BuildRunChanges): BuildRun;
  saveLogs(id: string, value: string): void;
}
export interface LegacyBuildRunInputs {
  input(id: string): BuildInput;
}
/** Dispatch receives current local intent without owning status, polling or retry authority. */
export interface BuildRunDispatchScope {
  closed(): boolean;
  current(): BuildRun;
}
export interface BuildRunDispatcher {
  start(job: BuildRun, scope: BuildRunDispatchScopeMetadata): Promise<BuildExecution>;
}

/** The artifact adapter validates output and file digests before making collected bytes visible. */
export interface BuildRunArtifacts {
  put(id: string, output: BuildArtifact): Promise<BuildArtifact>;
}

export interface BuildRunRetention {
  prune(reservedBytes?: number): Promise<void>;
  stop(): void;
}

export interface BuildRetentionStore {
  active(): BuildRun[];
  artifacts(): BuildRun[];
  update(id: string, changes: BuildRunChanges): BuildRun;
}

export type BuildRunStoreMetadata = MetadataStore<BuildRunStore>;
export type LegacyBuildRunInputsMetadata = MetadataStore<LegacyBuildRunInputs>;
export type BuildRetentionStoreMetadata = MetadataStore<BuildRetentionStore>;
export type BuildRunDispatchScopeMetadata = Omit<BuildRunDispatchScope, "current"> &
  MetadataStore<Pick<BuildRunDispatchScope, "current">>;
