import type { MetadataStore } from "../../../shared/async-value.js";
import type { SiteBuild, SiteBuildRequest, BuildAvailability } from "../../../shared/builds/jobs.js";
import type { ResourceBuildRequest } from "../../../shared/builds/resources.js";
import type { BuildSourceSnapshot } from "../source-port.js";
import type { ResourceInputLedger, ResourceInputReservation } from "../resource-input-port.js";

export interface NativeProjectJobs extends ResourceInputLedger<SiteBuild> {
  authorize(actor: string | undefined, id: string): void;
  reserve(
    actor: string,
    request: SiteBuildRequest,
    input: ResourceBuildRequest,
    sources: BuildSourceSnapshot["sources"],
    snapshot?: SiteBuild["sourceSnapshot"],
  ): { value: ResourceInputReservation<SiteBuild>; created: boolean };
  reservation(id: string): ResourceInputReservation<SiteBuild>;
}
/** Project authorization and source capture stay with the build application; this port owns native input admission. */
export interface NativeProjectBuilds {
  capture(
    actor: string | undefined,
    request: SiteBuildRequest,
    snapshot: BuildSourceSnapshot,
    availability: BuildAvailability,
    authorizeSource: () => Promise<void>,
  ): Promise<SiteBuild>;
  resume(actor: string | undefined, job: SiteBuild): Promise<SiteBuild>;
  authorizeRead(actor: string | undefined, job: SiteBuild): void;
  cancel(job: SiteBuild): SiteBuild;
  cleanup(id: string): Promise<void>;
  recover(): Promise<void>;
}

export type NativeProjectBuildMetadata = Omit<NativeProjectBuilds, "authorizeRead" | "cancel"> &
  MetadataStore<Pick<NativeProjectBuilds, "authorizeRead" | "cancel">>;
