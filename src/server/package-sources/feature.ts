import type { MetadataStore } from "../../shared/async-value.js";
import type { SourceStageStore } from "../packages/staging/ports.js";
import type { PackageSourceStageOptions } from "../packages/staging/feature.js";
import { join } from "node:path";
import type { RouteContext } from "../http/router.js";
import { createPackageSourceStages } from "../packages/staging/feature.js";
import { packageSourceRoutes } from "./routes.js";
import { sourceLimits } from "../../shared/packages/sources/contracts.js";

export function createPackageSourceFeature<S extends MetadataStore<SourceStageStore> = SourceStageStore>(
  options: Omit<PackageSourceStageOptions<S>, "root"> & {
    stateRoot: string;
    owner(context: RouteContext): string;
  },
) {
  const { stateRoot, owner, ...ports } = options,
    limits = sourceLimits(ports.limits),
    feature = createPackageSourceStages({ ...ports, limits, root: join(stateRoot, "package-sources") });
  return {
    ingestion: feature.ingestion,
    routes: packageSourceRoutes(feature.ingestion, owner, limits),
    start: () => feature.ingestion.start(),
    close: feature.close,
  };
}
