import type { OwnedPackageSources } from "../../../shared/packages/ownership.js";
import type { MetadataStore } from "../../../shared/async-value.js";
export type OwnedSourceMetadata = Omit<OwnedPackageSources, "find"> & MetadataStore<Pick<OwnedPackageSources, "find">>;
