import { metadataFailure, type MetadataStore } from "../../../shared/async-value.js";
import type { BuildRunStoreMetadata, LegacyBuildRunInputsMetadata } from "../../builds/runtime/ports.js";
import { SiteBuildError } from "../../builds/errors.js";
import { PluginRegistryError } from "../errors.js";
import type { SiteSampleStore } from "../ports.js";

/** Translate a plugin storage fault once at the runtime boundary so corrupt inputs fail instead of retrying forever. */
export function siteSampleRunStore(
  jobs: MetadataStore<SiteSampleStore>,
): BuildRunStoreMetadata & LegacyBuildRunInputsMetadata {
  return {
    active: () => jobs.active(),
    get: (id) => jobs.get(id),
    update: jobs.update.bind(jobs),
    saveLogs: jobs.saveLogs.bind(jobs),
    input(id) {
      return metadataFailure(
        () => jobs.input(id),
        (error) => {
          if (error instanceof PluginRegistryError) throw new SiteBuildError("snapshotUnavailable", 503);
          throw error;
        },
      );
    },
  };
}
