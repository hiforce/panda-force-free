import type { MetadataStore } from "../metadata-ports.js";
import type {
  KnowledgeGenerationSource,
  StoredGenerationPolicy,
  KnowledgeGenerationPolicyStore,
  KnowledgeGenerationJobStore,
} from "./contracts.js";
import { generationReadScope, generationSelectedSnapshot } from "./sources.js";
/** Fair metadata-only scans persist their checkpoint and backoff; they never submit a task or call an engine. */
export class KnowledgeGenerationDiscovery {
  private after: StoredGenerationPolicy | undefined;
  constructor(
    private policies: MetadataStore<KnowledgeGenerationPolicyStore>,
    private queue: MetadataStore<KnowledgeGenerationJobStore>,
    private source: KnowledgeGenerationSource,
    private execution: {
      interrupt(owner: string, id: string): void;
    },
    private report: (error: unknown) => void,
    private now = () => Date.now(),
  ) {}
  async scan(signal: AbortSignal) {
    const policy = (await this.policies.next(this.now(), this.after)) ?? (await this.policies.next(this.now()));
    if (!policy) return;
    this.after = policy;
    let checked = policy;
    try {
      const head = await this.source.head(policy.owner, policy.project);
      if (signal.aborted) return;
      if (head !== policy.observedCommit) {
        const snapshot = await this.source.snapshot(
          policy.owner,
          policy.project,
          generationReadScope(policy.selection),
        );
        if (signal.aborted) return;
        const matched = generationSelectedSnapshot(snapshot, policy.selection);
        for (const id of await this.queue.reconcile(policy, matched, this.now()))
          this.execution.interrupt(policy.owner, id);
        checked = { ...policy, observedCommit: snapshot.commit };
      }
      await this.policies.checked(checked, this.now(), false);
    } catch (error) {
      await this.policies.checked(policy, this.now(), true);
      this.report(error);
    }
  }
}
