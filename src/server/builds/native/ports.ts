import type { MetadataStore } from "../../../shared/async-value.js";
import type { NativeSampleBuild, NativeBuildThemeRef } from "../../../shared/builds/native-samples.js";
import type { NativeThemeDefinition } from "../../../shared/builds/native-theme.js";
import type { ImmutableSourceTree } from "../../../shared/packages/sources/tree.js";
import type { BuildEngine } from "../../../shared/builds/engines.js";
import type { BuildRunChanges } from "../../../shared/builds/run.js";
import type { BuildRunStore, BuildRetentionStore } from "../runtime/ports.js";

export interface NativeSampleReservation {
  job: NativeSampleBuild;
  ready: boolean;
  reservedBytes: number;
}
/** Theme access exposes only an approved selected projection, never the complete private source archive. */
export interface NativeBuildThemes {
  describe(actor: string, ref: NativeBuildThemeRef): { engine: BuildEngine };
  authorize(actor: string, ref: NativeBuildThemeRef): void;
  with<T>(
    actor: string,
    ref: NativeBuildThemeRef,
    read: (theme: { definition: NativeThemeDefinition; resources: ImmutableSourceTree }) => Promise<T>,
  ): Promise<T>;
}
export interface NativeSampleStore extends BuildRunStore, BuildRetentionStore {
  existing(actor: string, id: string, signature: string): NativeSampleReservation | null;
  reserve(
    actor: string,
    signature: string,
    job: NativeSampleBuild,
  ): { value: NativeSampleReservation; created: boolean };
  accept(id: string, inputHash: string, bytes: number): NativeSampleBuild;
  owner(id: string): string;
  get(id: string): NativeSampleBuild;
  update(id: string, changes: BuildRunChanges): NativeSampleBuild;
  reservation(id: string): NativeSampleReservation;
  pending(): NativeSampleReservation[];
  cleanup(): NativeSampleBuild[];
  released(id: string): void;
  latest(actor: string, key: string): NativeSampleBuild | null;
  list(actor: string): NativeSampleBuild[];
  logs(id: string): string;
  archive(id: string): void;
}

export type NativeBuildThemeMetadata = Omit<NativeBuildThemes, "describe" | "authorize"> &
  MetadataStore<Pick<NativeBuildThemes, "describe" | "authorize">>;
