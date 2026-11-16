import { mapMetadata, type MetadataStore, type MetadataValue } from "../../../shared/async-value.js";
import type { SiteBuild, SiteBuildRequest, BuildAvailability } from "../../../shared/builds/jobs.js";
import { ResourceBuildRequest } from "../../../shared/builds/resources.js";
import { BUILD_ENGINES } from "../../../shared/builds/engines.js";
import type { BuildSourceSnapshot } from "../source-port.js";
import type { ResourceBuildInputs } from "../resource-input-port.js";
import type { NativeBuildThemeMetadata } from "./ports.js";
import type { NativeProjectJobs, NativeProjectBuildMetadata } from "./project-ports.js";
import { ResourceInputLifecycle } from "../resource-input-lifecycle.js";
import { assertBuildCapabilities } from "../capabilities.js";
import { nativeBuildActor } from "./commands.js";
import { SiteBuildError } from "../errors.js";
import { resourceBuildRequirements } from "../../../shared/builds/capabilities.js";
import type { BuildMutation } from "../job-port.js";
/** Native theme bytes remain under the theme allocation lease until the complete project input is durable. */
export class NativeProjectBuildService<
  S extends MetadataStore<NativeProjectJobs> = NativeProjectJobs,
> implements NativeProjectBuildMetadata {
  private inputs: ResourceInputLifecycle<SiteBuild>;
  constructor(
    private jobs: S,
    files: ResourceBuildInputs,
    private themes: NativeBuildThemeMetadata,
    wake: () => void,
    now = Date.now,
    private mutation: BuildMutation = (work) => work(),
  ) {
    this.inputs = new ResourceInputLifecycle(jobs, files, wake, now);
  }
  async capture(
    actor: string | undefined,
    request: SiteBuildRequest,
    snapshot: BuildSourceSnapshot,
    availability: BuildAvailability,
    authorizeSource: () => Promise<void>,
  ) {
    nativeBuildActor(actor);
    const ref = request.nativeTheme;
    if (!ref) throw new SiteBuildError("invalidInput");
    if (!availability.nativeResources) throw new SiteBuildError("resourceBuildExecutorRequired", 503);
    if (availability.engines[request.engine] !== BUILD_ENGINES[request.engine])
      throw new SiteBuildError("incompatibleImage", 503);
    await this.themes.authorize(actor, ref);
    assertBuildCapabilities(snapshot.input, availability);
    return await this.themes.with(actor, ref, async (theme) => {
      if (theme.definition.engine !== request.engine) throw new SiteBuildError("incompatibleTheme");
      const input = await ResourceBuildRequest.create(snapshot.input, theme.definition, theme.resources);
      assertBuildCapabilities(
        snapshot.input,
        availability,
        resourceBuildRequirements(snapshot.input, input.descriptor.files),
      );
      const reserved = await this.mutation(async () => {
        await authorizeSource();
        await this.themes.authorize(actor, ref);
        return this.jobs.reserve(actor, request, input, snapshot.sources, snapshot.sourceSnapshot);
      });
      return reserved.created ? this.inputs.create(reserved.value.job, input) : this.inputs.resume(reserved.value);
    });
  }
  authorizeRead(actor: string | undefined, job: SiteBuild): MetadataValue<S, NativeProjectJobs, void> {
    return this.jobs.authorize(actor, job.id) as MetadataValue<S, NativeProjectJobs, void>;
  }
  async resume(actor: string | undefined, job: SiteBuild) {
    await this.authorizeRead(actor, job);
    return this.inputs.resume(await this.jobs.reservation(job.id));
  }
  cancel(job: SiteBuild): MetadataValue<S, NativeProjectJobs, SiteBuild> {
    return mapMetadata(this.jobs.reservation(job.id), (reservation) =>
      this.jobs.update(job.id, { phase: reservation.ready ? "cancelling" : "cancelled" }),
    ) as MetadataValue<S, NativeProjectJobs, SiteBuild>;
  }
  cleanup(id: string) {
    return this.inputs.cleanup(id);
  }
  recover() {
    return this.inputs.recover();
  }
}
