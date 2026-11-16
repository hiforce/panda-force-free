import type { EditorialJobFailure } from "../../../shared/editorial/jobs.js";
import { stableJson } from "../../../shared/stable-json.js";
import { EditorialPatchError } from "../../../shared/editorial/rich-edits.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { EditorialModelOutputError, type EditorialModel } from "../model/contracts.js";
import { editorialModelInput, reviewedModelOutput } from "../model/exchange.js";
import type { MySQLEditorialService } from "../mysql-service.js";
import type { AsyncEditorialSources } from "../async-ports.js";
import { EditorialLeaseLost } from "./contracts.js";
import type { MySQLEditorialJobRepository } from "./mysql-repository.js";
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
export class MySQLEditorialWorker {
  private running = false;
  constructor(
    private repository: MySQLEditorialJobRepository,
    private editorial: MySQLEditorialService,
    private sources: AsyncEditorialSources,
    private models: ReadonlyMap<string, EditorialModel>,
    private now: () => number = Date.now,
    private timeoutMs = 120000,
  ) {}
  async runOne(stopping?: AbortSignal): Promise<boolean> {
    if (this.running || stopping?.aborted) return false;
    this.running = true;
    const leaseMs = 30000;
    let selected: Awaited<ReturnType<MySQLEditorialJobRepository["claim"]>>;
    try {
      selected = await this.repository.claim(this.now(), leaseMs);
    } catch (error) {
      this.running = false;
      throw error;
    }
    if (!selected) {
      this.running = false;
      return false;
    }
    const claim = selected;
    const controller = new AbortController(),
      stop = () => controller.abort(new Error("interrupted"));
    let timedOut = false,
      maintenance: Promise<void> | null = null;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
      }, this.timeoutMs),
      heartbeat = setInterval(() => {
        if (!maintenance)
          maintenance = maintain().finally(() => {
            maintenance = null;
          });
      }, leaseMs / 3);
    const maintain = async () => {
      try {
        if (!(await this.repository.heartbeat(claim, this.now(), leaseMs)))
          controller.abort(new EditorialLeaseLost("leaseLost"));
      } catch (error) {
        reportDiagnostic("editorial-job-heartbeat", error);
        controller.abort(new EditorialLeaseLost("leaseLost"));
      }
    };
    timer.unref();
    heartbeat.unref();
    stopping?.addEventListener("abort", stop, { once: true });
    if (stopping?.aborted) stop();
    let failure: EditorialJobFailure = "processingFailed";
    try {
      const { spec } = claim,
        model = this.models.get(spec.profile.id);
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
        {
          schema: 1,
          id: spec.proposalId,
          source: spec.source.ref,
          mode: spec.mode,
          ...result,
          createdAt: this.now(),
        },
      );
      controller.signal.throwIfAborted();
      await this.repository.complete(claim, this.now(), async () => (await commit()).proposal.id);
    } catch (error) {
      if (stopping?.aborted) await this.repository.release(claim, this.now());
      else if (!(error instanceof EditorialLeaseLost)) {
        if (timedOut) failure = "timeout";
        else if (error instanceof EditorialModelOutputError || error instanceof EditorialPatchError)
          failure = "invalidOutput";
        await this.repository.fail(claim, this.now(), failure);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      await maintenance;
      stopping?.removeEventListener("abort", stop);
      this.running = false;
    }
    return true;
  }
}
