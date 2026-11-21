import type { EditorialJobFailure } from "../../../shared/editorial/jobs.js";
import { stableJson } from "../../../shared/stable-json.js";
import { EditorialPatchError } from "../../../shared/editorial/rich-edits.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { EditorialModelOutputError, type EditorialModel } from "../model/contracts.js";
import { editorialModelInput, reviewedModelOutput } from "../model/exchange.js";
import type { EditorialService } from "../service.js";
import type { EditorialSources } from "../ports.js";
import { EditorialLeaseLost } from "./contracts.js";
import type { EditorialJobRepository } from "./repository.js";

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
/** One bounded execution per worker. Lease tokens fence late results, including adapters that ignore cancellation. */
export class EditorialWorker {
  private running = false;
  constructor(
    private repository: EditorialJobRepository,
    private editorial: EditorialService,
    private sources: EditorialSources,
    private models: ReadonlyMap<string, EditorialModel>,
    private now: () => number = Date.now,
    private timeoutMs = 120000,
    private readonly runtimes?: import("../model/runtime.js").EditorialRuntimePort,
  ) {}
  async runOne(stopping?: AbortSignal): Promise<boolean> {
    if (this.running || stopping?.aborted) return false;
    const leaseMs = 30000,
      claim = this.repository.claim(this.now(), leaseMs);
    if (!claim) return false;
    this.running = true;
    const controller = new AbortController(),
      stop = () => controller.abort(new Error("interrupted"));
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
      }, this.timeoutMs),
      heartbeat = setInterval(() => {
        try {
          if (!this.repository.heartbeat(claim, this.now(), leaseMs))
            controller.abort(new EditorialLeaseLost("leaseLost"));
        } catch (error) {
          reportDiagnostic("editorial-job-heartbeat", error);
          controller.abort(new EditorialLeaseLost("leaseLost"));
        }
      }, leaseMs / 3);
    timer.unref();
    heartbeat.unref();
    stopping?.addEventListener("abort", stop, { once: true });
    if (stopping?.aborted) stop();
    let failure: EditorialJobFailure = "processingFailed";
    try {
      const { spec } = claim,
        model =
          spec.profile.runtimeId && this.runtimes
            ? this.runtimes.model(claim.row.owner, spec.profile)
            : this.models.get(spec.profile.id);
      await this.sources.current(spec.source.ref.documentId, spec.source.ref.projectId);
      const source = await this.sources.revision(
        spec.source.ref.documentId,
        spec.source.ref.revisionId,
        spec.source.ref.projectId,
      );
      if (stableJson(source.ref) !== stableJson(spec.source.ref)) throw new Error("Editorial source revision changed");
      if (!model || stableJson(model.profile) !== stableJson(spec.profile)) {
        failure = "processorUnavailable";
        throw new Error(failure);
      }
      const input = editorialModelInput(source, spec.mode),
        output = input.segments.length
          ? await abortable(
              model.process(structuredClone(input), {
                operationId: `${spec.id}:${claim.job.generation}`,
                attempt: claim.job.attempts,
                generation: claim.job.generation,
                signal: controller.signal,
              }),
              controller.signal,
            )
          : '{"edits":[]}',
        result = reviewedModelOutput(source, input, spec.profile, output);
      controller.signal.throwIfAborted();
      const commit = await this.editorial.stagePrepared(
        claim.row.owner,
        stableJson({ kind: "model-job", id: spec.id, digest: claim.row.digest }),
        { schema: 1, id: spec.proposalId, source: spec.source.ref, mode: spec.mode, ...result, createdAt: this.now() },
      );
      controller.signal.throwIfAborted();
      this.repository.complete(claim, this.now(), () => commit().proposal.id);
    } catch (error) {
      if (stopping?.aborted) this.repository.release(claim, this.now());
      else if (!(error instanceof EditorialLeaseLost)) {
        if (timedOut) failure = "timeout";
        else if (error instanceof EditorialModelOutputError || error instanceof EditorialPatchError)
          failure = "invalidOutput";
        this.repository.fail(claim, this.now(), failure);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      stopping?.removeEventListener("abort", stop);
      this.running = false;
    }
    return true;
  }
}
