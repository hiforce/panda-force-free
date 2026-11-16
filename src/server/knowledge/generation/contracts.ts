import type { SavedSourceKind } from "../../../shared/content-sources/contracts.js";
import type { GenerationOriginalKind } from "../../../shared/knowledge/generation-originals.js";
import type {
  KnowledgeGenerationPolicy,
  KnowledgeGenerationChange,
  KnowledgeGenerationSourcePage,
  KnowledgeGenerationStatus,
} from "../../../shared/knowledge/generation.js";

export interface GenerationSourceIdentity {
  id: string;
  kind: SavedSourceKind;
  version: string;
}
export interface GenerationReadScope {
  documents: boolean;
  originals: readonly GenerationOriginalKind[];
}
export interface GenerationOriginal extends GenerationSourceIdentity {
  kind: GenerationOriginalKind;
}
export interface GenerationDocument {
  id: string;
  parentId: string | null;
  version: string;
}
export interface GenerationSnapshot {
  commit: string;
  documents: GenerationDocument[];
  originals?: GenerationOriginal[];
}
export interface KnowledgeGenerationSource {
  snapshot(owner: string, project: string, scope?: GenerationReadScope): Promise<GenerationSnapshot>;
  head(owner: string, project: string): Promise<string>;
  /** Final metadata validation holds the source authority's read lease through synchronous task admission. */
  withSnapshot<T>(
    owner: string,
    project: string,
    work: (snapshot: GenerationSnapshot, assertHeld: () => void) => T,
    scope?: GenerationReadScope,
  ): Promise<T>;
  /** Explicit configuration may initialize an empty owned source before taking its final baseline lease. */
  withBaseline?<T>(
    owner: string,
    project: string,
    expectedCommit: string | undefined,
    work: (snapshot: GenerationSnapshot, assertHeld: () => void) => T,
    scope?: GenerationReadScope,
  ): Promise<T>;
}
export interface KnowledgeGenerationCatalog {
  sources(owner: string, project: string, offset: number, commit?: string): Promise<KnowledgeGenerationSourcePage>;
}
export interface KnowledgeGenerationStatusReads {
  status(owner: string, project: string, now: number): KnowledgeGenerationStatus;
}
export interface StoredGenerationPolicy extends KnowledgeGenerationPolicy {
  owner: string;
  project: string;
  observedCommit: string | null;
}
export interface GenerationLease {
  owner: string;
  project: string;
  source: GenerationSourceIdentity;
  policyRevision: number;
  operationId: string;
  token: string;
  purpose: string;
}
export interface KnowledgeGenerationPolicyStore {
  policy(owner: string, project: string): StoredGenerationPolicy;
  next(now: number, after?: { owner: string; project: string }): StoredGenerationPolicy | null;
  configure(
    owner: string,
    project: string,
    value: KnowledgeGenerationChange,
    matched: GenerationSnapshot | null,
    now: number,
  ): { policy: StoredGenerationPolicy; cancelled: string[] };
  checked(policy: StoredGenerationPolicy, now: number, failed: boolean): void;
}
export interface KnowledgeGenerationJobStore {
  /** Callers supply the complete matching set from one saved navigation snapshot. */
  reconcile(policy: StoredGenerationPolicy, matched: GenerationSnapshot, now: number): string[];
  claim(now: number): GenerationLease | null;
  heartbeat(lease: GenerationLease, now: number): void;
  release(lease: GenerationLease, now: number, retryAt: number, failed?: boolean, pauseScope?: boolean): void;
}
export interface KnowledgeGenerationAdmissions {
  usage(owner: string, project: string, now: number): number;
  admit(lease: GenerationLease, taskId: string, created: boolean, now: number): void;
  retryAt(owner: string, project: string, dailyLimit: number, now: number): number;
}
