import type { MetadataStore } from "../../../shared/async-value.js";
import type { SourceStageStore } from "../../packages/staging/ports.js";
import type { OwnedSourceMetadata } from "../../packages/ownership/ports.js";
import type { PackageSourceStages } from "../../packages/staging/service.js";
import type { PackageSourceIngestion } from "../../packages/ingestion/service.js";
import type { NativeThemeSources } from "../native/ports.js";
import { NativeThemeError } from "../../../shared/templates/native/contracts.js";
import { OwnedSourceError } from "../../../shared/packages/ownership.js";
import { ownedStagedSources } from "../../packages/ownership/staged.js";

/** Site themes translate neutral ownership failures at their domain boundary. */
export function ownedNativeSources(stages: PackageSourceStages, ingestion: PackageSourceIngestion): NativeThemeSources;
export function ownedNativeSources(
  stages: PackageSourceStages<MetadataStore<SourceStageStore>>,
  ingestion: PackageSourceIngestion<MetadataStore<SourceStageStore>>,
): OwnedSourceMetadata;
export function ownedNativeSources(
  stages: PackageSourceStages<MetadataStore<SourceStageStore>>,
  ingestion: PackageSourceIngestion<MetadataStore<SourceStageStore>>,
): OwnedSourceMetadata {
  const sources = ownedStagedSources(stages, ingestion);
  async function translated<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof OwnedSourceError)
        throw new NativeThemeError(error.code === "capacity" ? "storageFull" : error.code);
      throw error;
    }
  }
  return {
    save: (actor, id, source) => translated(() => sources.save(actor, id, source)),
    find: (actor, id) => sources.find(actor, id),
    with: (actor, source, run) => translated(() => sources.with(actor, source, run)),
    recover: (actor, id) => translated(() => sources.recover(actor, id)),
    remove: (actor, id) => sources.remove(actor, id),
  };
}
