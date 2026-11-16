import type { MetadataStore } from "../metadata-ports.js";
import { generationChange } from "../../../shared/knowledge/generation.js";
import { knowledgeId } from "../../../shared/knowledge/primitives.js";
import type { KnowledgeContent } from "../tasks/contracts.js";
import type {
  KnowledgeGenerationSource,
  KnowledgeGenerationPolicyStore,
  KnowledgeGenerationCatalog,
  KnowledgeGenerationStatusReads,
  GenerationSnapshot,
} from "./contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { generationReadScope, generationSelectedSnapshot, generationIdentities } from "./sources.js";
/** Explicit configuration snapshots an exact baseline; backfill is a separate affirmative choice. */
export class KnowledgeGenerationSettings {
  constructor(
    private policies: MetadataStore<KnowledgeGenerationPolicyStore>,
    private source: KnowledgeGenerationSource,
    private content: Pick<KnowledgeContent, "authorize">,
    private execution: {
      interrupt(owner: string, id: string): void;
      wake(): void;
    },
    private now = () => Date.now(),
    private reads?: {
      catalog: KnowledgeGenerationCatalog;
      status: MetadataStore<KnowledgeGenerationStatusReads>;
    },
  ) {}
  async sources(owner: string, project: string, offset: number, commit?: string) {
    knowledgeId(project);
    if (!this.reads) throw new KnowledgeTaskError("unavailable");
    await this.content.authorize(owner, project);
    const result = await this.reads.catalog.sources(owner, project, offset, commit);
    await this.content.authorize(owner, project);
    return result;
  }
  async status(owner: string, project: string) {
    knowledgeId(project);
    if (!this.reads) throw new KnowledgeTaskError("unavailable");
    await this.content.authorize(owner, project);
    return await this.reads.status.status(owner, project, this.now());
  }
  async policy(owner: string, project: string) {
    knowledgeId(project);
    await this.content.authorize(owner, project);
    const {
      owner: _owner,
      project: _project,
      observedCommit: _commit,
      ...policy
    } = await this.policies.policy(owner, project);
    return policy;
  }
  async preview(owner: string, project: string, input: unknown) {
    knowledgeId(project);
    const change = generationChange(input);
    await this.content.authorize(owner, project);
    const snapshot = await this.source.snapshot(owner, project, generationReadScope(change.selection)),
      selected = generationSelectedSnapshot(snapshot, change.selection),
      matched = generationIdentities(selected);
    await this.content.authorize(owner, project);
    return {
      commit: snapshot.commit,
      count: matched.length,
      documents: selected.documents.slice(0, 50).map((doc) => doc.id),
      ...(change.selection.originals
        ? {
            originals: (selected.originals ?? []).slice(0, 50).map(({ id, kind }) => ({ id, kind })),
            counts: {
              documents: selected.documents.length,
              web: selected.originals?.filter((row) => row.kind === "web").length ?? 0,
              slides: selected.originals?.filter((row) => row.kind === "slides").length ?? 0,
            },
          }
        : {}),
      truncated: matched.length > 50,
    };
  }
  async configure(owner: string, project: string, input: unknown, expectedCommit?: string) {
    knowledgeId(project);
    const change = generationChange(input);
    await this.content.authorize(owner, project);
    if ((await this.policies.policy(owner, project)).revision !== change.revision)
      throw new KnowledgeTaskError("conflict");
    const configure = async (snapshot: GenerationSnapshot, assertHeld: () => void) => {
      const matched = generationSelectedSnapshot(snapshot, change.selection);
      assertHeld();
      return await this.policies.configure(owner, project, change, matched, this.now());
    };
    const result = change.enabled
      ? this.source.withBaseline
        ? await this.source.withBaseline(
            owner,
            project,
            expectedCommit,
            configure,
            generationReadScope(change.selection),
          )
        : await this.source.withSnapshot(
            owner,
            project,
            (snapshot, assertHeld) => {
              if (expectedCommit !== undefined && snapshot.commit !== expectedCommit)
                throw new KnowledgeTaskError("conflict");
              return configure(snapshot, assertHeld);
            },
            generationReadScope(change.selection),
          )
      : await this.policies.configure(owner, project, change, null, this.now());
    for (const id of result.cancelled) this.execution.interrupt(owner, id);
    this.execution.wake();
    const { owner: _owner, project: _project, observedCommit: _commit, ...policy } = result.policy;
    return policy;
  }
}
