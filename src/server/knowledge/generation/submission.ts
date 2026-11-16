import type { MetadataStore } from "../metadata-ports.js";
import type {
  KnowledgeGenerationPolicyStore,
  KnowledgeGenerationJobStore,
  KnowledgeGenerationAdmissions,
  KnowledgeGenerationSource,
  GenerationLease,
} from "./contracts.js";
import type { KnowledgeTasks } from "../tasks/service.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { generationReadScope, generationSelectedSnapshot, generationIdentities } from "./sources.js";
/** One durable desired version enters the shared task queue only under current file, policy, lease and quota fences. */
export class KnowledgeGenerationSubmission {
  constructor(
    private policies: MetadataStore<KnowledgeGenerationPolicyStore>,
    private queue: MetadataStore<KnowledgeGenerationJobStore>,
    private admission: MetadataStore<KnowledgeGenerationAdmissions>,
    private source: KnowledgeGenerationSource,
    private tasks: Pick<KnowledgeTasks, "submit">,
    private enabled: () => boolean,
    private now = () => Date.now(),
  ) {}
  private async withSource<T>(lease: GenerationLease, commit: string, create: (assertHeld: () => void) => T) {
    const expected = await this.policies.policy(lease.owner, lease.project);
    return this.source.withSnapshot(
      lease.owner,
      lease.project,
      async (snapshot, assertHeld) => {
        const current = await this.policies.policy(lease.owner, lease.project);
        if (
          snapshot.commit !== commit ||
          !current.enabled ||
          current.revision !== lease.policyRevision ||
          !generationIdentities(generationSelectedSnapshot(snapshot, current.selection)).some(
            (source) =>
              source.id === lease.source.id &&
              source.version === lease.source.version &&
              source.kind === lease.source.kind,
          )
        )
          throw new KnowledgeTaskError("conflict");
        return create(assertHeld);
      },
      generationReadScope(expected.selection),
    );
  }
  async run(signal: AbortSignal) {
    if (signal.aborted || !this.enabled()) return;
    const lease = await this.queue.claim(this.now());
    if (!lease) return;
    const heartbeat = setInterval(async () => {
      try {
        await this.queue.heartbeat(lease, this.now());
      } catch {
        clearInterval(heartbeat);
      }
    }, 10000);
    heartbeat.unref();
    try {
      await this.tasks.submit(
        lease.owner,
        {
          id: lease.operationId,
          project: lease.project,
          ids: [lease.source.id],
          purpose: lease.purpose,
          ...(lease.source.kind === "document" ? {} : { contentKinds: [lease.source.kind] }),
        },
        {
          source: lease.source,
          withSource: (commit, create) => this.withSource(lease, commit, create),
          commit: (id, created, now) => {
            if (signal.aborted || !this.enabled()) throw new KnowledgeTaskError("unavailable");
            return this.admission.admit(lease, id, created, now);
          },
        },
      );
    } catch (error) {
      const budget = error instanceof KnowledgeTaskError && error.code === "budget",
        policy = await this.policies.policy(lease.owner, lease.project),
        now = this.now();
      await this.queue.release(
        lease,
        now,
        budget ? await this.admission.retryAt(lease.owner, lease.project, policy.dailyLimit, now) : now + 5000,
        !budget && !signal.aborted,
        budget,
      );
      if (!budget && !signal.aborted) throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
