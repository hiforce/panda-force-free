import type { MetadataStore } from "../../../shared/async-value.js";
import type { BuildRunDispatcher } from "../runtime/ports.js";
import type { SiteExecutor } from "../executor-port.js";
import type { ResourceBuildInputs } from "../resource-input-port.js";
import type { NativeSampleStore, NativeBuildThemeMetadata } from "./ports.js";
import { resourceBuildDispatcher } from "../resource-dispatch.js";

/** Sample metadata supplies only the identity required by the common binary dispatcher. */
export function nativeSampleDispatcher(
  jobs: MetadataStore<NativeSampleStore>,
  files: ResourceBuildInputs,
  themes: NativeBuildThemeMetadata,
  executor: SiteExecutor,
): BuildRunDispatcher {
  return resourceBuildDispatcher(
    async (id) => ({ actor: await jobs.owner(id), theme: (await jobs.get(id)).theme }),
    files,
    themes,
    executor,
  );
}
