import {
  applyMemoryResolutions,
  MemoryConflicts,
  memoryResolutionKey,
  resolvedConflictKind,
  type MemoryConflictDestination,
  type MemoryResolution,
} from "./conflict-worker.js";
import { errorCode, errorStatus } from "../../shared/errors.js";
import { MemoryBackfills, type RecordedMemoryTurn } from "./backfill.js";
import { ProjectTeamMemory, type TeamProof } from "./team.js";
import type { ProjectSessionCheckpoint, ProjectSessionMembership } from "../projects/session-membership.js";
import type { MaterialCandidates, ProjectMemoryMaterialSearch } from "./material-search.js";
import type { MemoryMaterialSelection, MemoryPackageMaterial } from "../../shared/project-memory/materials.js";
import { memoryMaterialCitationId, memoryMaterialOriginals } from "../../shared/project-memory/materials.js";
import { materialDigest } from "./materials.js";
import type { MemoryArchiveImport } from "../../shared/project-memory/archive.js";
import type {
  MemoryEntry,
  MemoryManualConvention,
  MemoryPolicy,
  MemoryPreferences,
  ProjectMemoryLanguage,
  MemoryRemovalImpact,
  MemoryModelReview,
  MemorySourceLocation,
} from "../../shared/project-memory/contracts.js";
import { HarnessError } from "../../shared/harness/contracts.js";
import { visibleHarnessText } from "../../shared/harness/text.js";
import type { HarnessHistory, HarnessMetadata, HarnessMetadataTransaction, HarnessRecord } from "../harness/ports.js";
import { decode, save } from "../harness/records.js";
import {
  compatibleProjectMemory,
  describeMemory,
  groupMemoryEvidence,
  matchingMemories,
  matchesMemoryEntry,
  projectMemoryMatcher,
  projectMemories,
} from "./projection.js";
import {
  conversationKey,
  nativeMemoryKey,
  defaultPolicy,
  defaultSource,
  digest,
  compareMemoryOrder,
  entryId,
  evidenceKey,
  replacementKind,
  type MemoryOrder,
  evidenceKind,
  namespace,
  policyKey,
  policyKind,
  recallKind,
  sourceKey,
  type MemoryConversation,
  type MemoryEvidence,
  type MemoryRecall,
  type MemoryReceipt,
  type SourcePolicy,
} from "./records.js";
import { defaultMemoryLanguage, memoryLanguage, memoryLanguageLabel } from "../../shared/project-memory/language.js";
import { personalRecallMatches } from "./personal-recall.js";
import { memoryCredentialPattern } from "./rules.js";
import { organizedMemoryLinks } from "./relations.js";
import { readMemoryTerrain, reserveMemoryPlaces } from "./terrain.js";
import { appendMemoryVersions, readMemoryDetail } from "./timeline.js";
import { modelExcerpt, organizationEvidenceExcerpt, type ModelReviewPort } from "./model-review.js";
import {
  MemoryOrganizations,
  memoryOrganizationLookbackMs,
  organizeHistoryPage,
  type MemoryOrganizationBoundary,
} from "./organization-worker.js";
import { modelReviewKind } from "./model-worker.js";
import { indexedMemoryVersion, memorySearchDocuments } from "./search-documents.js";
import { ProjectMemorySearch, type MemorySearchProviders } from "./search-index.js";
import {
  archiveGrantKey,
  archiveGrantKind,
  archiveImportKey,
  archiveImportKind,
  archiveRecords,
  assertArchiveOrigin,
  createMemoryArchive,
  importSummary,
  parseMemoryArchive,
  prepareArchiveImport,
  type MemoryArchiveAuthorize,
  type MemoryArchiveGrant,
  type MemoryArchiveReceipt,
} from "./portability.js";

type Reader = Pick<HarnessMetadataTransaction, "get" | "list">;
type EntrySelector = (evidence: Pick<MemoryEvidence, "key" | "scope" | "title">) => boolean;

function referenceIds(references: readonly MemoryRecall[]) {
  const privateIds = new Set<string>(),
    teamIds = new Set<string>();
  for (const reference of references)
    if (!reference.material) (reference.team ? teamIds : privateIds).add(reference.id);
  return { privateIds, teamIds };
}
type ScopedConversation = MemoryConversation & { projectId: string; checkpoint: ProjectSessionCheckpoint | null };
const afterCheckpoint = (checkpoint: ProjectSessionCheckpoint | null, seq: number, throughBytes: number) =>
  !checkpoint || (seq > checkpoint.throughSeq && throughBytes > checkpoint.throughBytes);
type MemoryCandidates = {
  projectId: string;
  hits: ReadonlyMap<string, string>;
  available: boolean;
  salt?: string;
  materials?: MaterialCandidates;
};
const retractKind = "project-memory-retract";
const recallKey = (id: string) => `memory-recall:${id}`;
const automaticMemoryAllowed = (source: SourcePolicy, seq: number) =>
  source.pausedAfterSeq === undefined && seq > (source.pausedRanges?.at(-1)?.throughSeq ?? -1);

export class ProjectMemory {
  private readonly reader: Reader;
  private timer: ReturnType<typeof setInterval> | undefined;
  private processing: Promise<void> | undefined;
  readonly organizations: MemoryOrganizations;
  private backfillProcessing: Promise<void> | undefined;
  private readonly conflicts: MemoryConflicts;
  private conflictProcessing: Promise<void> | undefined;
  private readonly conflictDiscovery = new Map<string, Promise<void>>();
  private readonly stopBackfills = new AbortController();
  readonly backfills: MemoryBackfills;
  readonly team: ProjectTeamMemory;
  private readonly search?: ProjectMemorySearch;

  constructor(
    private readonly metadata: HarnessMetadata,
    private readonly history: HarnessHistory,
    private readonly authorize: (conversation: MemoryConversation, access?: "read" | "contribute") => Promise<void>,
    private readonly pathAllowed: (cwd: string) => boolean = () => true,
    private readonly now: () => number = Date.now,
    private readonly assignment?: (id: string) => Promise<ProjectSessionMembership | null>,
    private readonly models?: ModelReviewPort,
    searchProviders?: MemorySearchProviders,
    private readonly materialSearch?: ProjectMemoryMaterialSearch,
    private readonly legacyMembership?: (id: string) => Promise<ProjectSessionMembership | null>,
    private readonly authorizeProject?: MemoryArchiveAuthorize,
  ) {
    if (searchProviders)
      this.search = new ProjectMemorySearch(
        metadata,
        searchProviders,
        async (owner, project, salt) => memorySearchDocuments(await this.catalog(owner, project), salt),
        now,
      );
    this.reader = { get: (id) => metadata.read(id), list: (kind, owner) => metadata.list(kind, owner) };
    this.backfills = new MemoryBackfills(
      metadata,
      history,
      now,
      (destination, reader) => this.backfillScope(destination, reader),
      (tx, destination, turns) => this.recordClaims(tx, destination, turns),
      (input) =>
        organizeHistoryPage({
          ...input,
          history,
          reader: this.reader,
          models,
          entries: () => this.organizerEntries(input.owner, input.projectId),
          preferences: () => this.effectiveLanguage(input.owner, input.projectId),
        }),
    );
    this.organizations = new MemoryOrganizations(
      metadata,
      now,
      (work, reader) => this.organizationScope(work, reader),
      async (work, selection, signal) => {
        const page = await history.scanUserMessages(work.owner, work.conversationId, work.throughBytes, work.fromBytes);
        const turns = await organizeHistoryPage({
          ...work,
          selection,
          nextBytes: page.nextBytes,
          items: page.messages.filter(({ message }) => message.createdAt >= now() - memoryOrganizationLookbackMs),
          signal,
          eligible: async () => !!(await this.organizationScope(work, this.reader)),
          history,
          models,
          reader: this.reader,
          entries: () => this.organizerEntries(work.owner, work.projectId),
          preferences: () => this.effectiveLanguage(work.owner, work.projectId),
        });
        return { nextBytes: page.nextBytes, turns };
      },
      (tx, work, turns) => this.recordClaims(tx, work, turns),
    );
    this.conflicts = new MemoryConflicts(
      metadata,
      now,
      async (work, reader) => {
        const { owner, projectId, entry } = work;
        await this.authorizeProject?.(owner, projectId, "contribute");
        const [policy, preferences] = await Promise.all([
          this.policy(owner, projectId, reader),
          this.effectiveLanguage(owner, projectId, reader),
        ]);
        const { groups } = await this.readProjectEvidence(owner, projectId, reader, {
          select: ({ key, scope }) => entryId(key, scope) === entry,
        });
        return {
          group: groups.get(entry) ?? [],
          revision: `${policy.revision}:${preferences.revision}`,
          language: { tag: preferences.language, name: memoryLanguageLabel(preferences.language) },
          selection: policy.model.enabled ? policy.model.selection : null,
        };
      },
      async ({ owner }, selection, context, signal) => {
        if (
          !models?.resolveConflict ||
          !modelExcerpt(context.key) ||
          !modelExcerpt(context.scope) ||
          context.variants.some(({ value }) => !organizationEvidenceExcerpt(value))
        )
          return null;
        return models.resolveConflict(owner, selection, context, signal);
      },
      ({ owner, projectId }, row) => this.conflictEvidence(owner, projectId, row),
      async (tx, { owner, projectId, entry }) => {
        const { groups } = await this.readProjectEvidence(owner, projectId, tx, {
          select: ({ key, scope }) => entryId(key, scope) === entry,
        });
        await this.search?.dirty(tx, owner, projectId);
        await appendMemoryVersions(
          tx,
          namespace(owner, projectId),
          [entry],
          groups,
          now(),
          groups.has(entry) ? "learn" : "withdraw",
        );
      },
    );
    this.team = new ProjectTeamMemory(
      metadata,
      (owner, project, entry, reader) => this.teamPreviewOrigin(owner, project, entry, reader),
      (owner, project, entry, proofs, reader) => this.teamCurrentOrigin(owner, project, entry, proofs, reader),
    );
  }

  start() {
    this.timer ??= setInterval(() => this.wake(), 1500);
    this.timer.unref();
    if (this.models?.resolveConflict)
      this.conflictProcessing = this.discoverExistingConflicts()
        .catch(() => {})
        .finally(() => {
          this.conflictProcessing = undefined;
        });
    this.wake();
  }

  wake() {
    this.search?.wake();
    this.materialSearch?.wake();
    this.backfillProcessing ??= this.backfills
      .processReady(this.stopBackfills.signal)
      .catch(() => {})
      .finally(() => {
        this.backfillProcessing = undefined;
      });
    if (this.models?.resolveConflict)
      this.conflictProcessing ??= this.conflicts
        .process(this.stopBackfills.signal)
        .catch(() => {})
        .finally(() => {
          this.conflictProcessing = undefined;
        });
    this.processing ??= this.processPending()
      .catch(() => {})
      .finally(() => {
        this.processing = undefined;
      });
  }

  async close() {
    clearInterval(this.timer);
    this.stopBackfills.abort();
    await Promise.all([
      this.processing,
      this.backfillProcessing,
      this.conflictProcessing,
      this.search?.close(),
      this.materialSearch?.close(),
      ...this.conflictDiscovery.values(),
    ]);
  }

  private async conflictEvidence(owner: string, projectId: string, row: MemoryEvidence) {
    if (!row.conversationId) return undefined;
    const source = await this.readSource(owner, projectId, row.conversationId, this.reader);
    if (!source || (await this.source(source.id)).generation !== row.generation) return undefined;
    await this.authorize(source);
    const message = await this.history.messageAt(owner, source.id, source.historyBytes, row);
    return message?.role === "user" ? organizationEvidenceExcerpt(message.text)?.slice(0, 360) : undefined;
  }

  private discoverProjectConflicts(owner: string, projectId: string) {
    const bucket = namespace(owner, projectId);
    if (this.stopBackfills.signal.aborted || !this.models?.resolveConflict || this.conflictDiscovery.has(bucket))
      return;
    const work = this.metadata
      .transaction(async (tx) => {
        const { groups } = await this.readProjectEvidence(owner, projectId, tx);
        await this.enqueueConflicts(tx, owner, projectId, groups);
      })
      .catch(() => {
        this.conflictDiscovery.delete(bucket);
      });
    this.conflictDiscovery.set(bucket, work);
    return work;
  }

  private async discoverExistingConflicts() {
    const sources = (
      await Promise.all([
        this.metadata.list(policyKind),
        this.metadata.list("conversation"),
        this.metadata.list("memory-native-source"),
      ])
    ).flat();
    for (const record of sources) {
      if (this.stopBackfills.signal.aborted) return;
      const source = decode<{ owner?: string; projectId?: string }>(record);
      if (source && record.kind === policyKind && source.owner && source.projectId) {
        await this.discoverProjectConflicts(source.owner, source.projectId);
      } else if (source?.owner && record.kind !== policyKind) {
        const scoped = await this.scope(decode<MemoryConversation>(record)!).catch(() => null);
        if (scoped) await this.discoverProjectConflicts(scoped.owner, scoped.projectId);
      }
    }
  }

  private async enqueueConflicts(
    tx: HarnessMetadataTransaction,
    owner: string,
    projectId: string,
    groups: ReadonlyMap<string, MemoryEvidence[]>,
    affected?: ReadonlySet<string>,
  ) {
    if (!this.models?.resolveConflict) return;
    for (const [entry, group] of groups)
      if (!affected || affected.has(entry)) await this.conflicts.detect(tx, { owner, projectId, entry }, group);
  }

  async preferences(owner: string, reader = this.reader): Promise<MemoryPreferences> {
    return (
      decode<MemoryPreferences>(await reader.get("memory-preferences:" + digest(owner))) ?? {
        revision: 0,
        language: defaultMemoryLanguage,
      }
    );
  }

  async setPreferences(owner: string, revision: unknown, selection: unknown) {
    const language = memoryLanguage(selection);
    if (!language || !Number.isSafeInteger(revision) || Number(revision) < 0) throw new HarnessError("invalidInput");
    return this.metadata.transaction(async (tx) => {
      const current = await this.preferences(owner, tx);
      if (current.revision !== revision) throw new HarnessError("conflict", 409);
      if (current.language === language) return current;
      const next = { revision: current.revision + 1, language };
      await save(tx, "memory-preferences:" + digest(owner), "memory-preferences", owner, next);
      return next;
    });
  }

  async projectLanguage(owner: string, project: string, reader = this.reader): Promise<ProjectMemoryLanguage> {
    const key = "memory-language:" + namespace(owner, project);
    const [row, system] = await Promise.all([reader.get(key), this.preferences(owner, reader)]);
    return {
      ...(decode<Pick<ProjectMemoryLanguage, "revision" | "language">>(row) ?? { revision: 0, language: null }),
      inheritedLanguage: system.language,
    };
  }

  async setProjectLanguage(owner: string, project: string, revision: unknown, selection: unknown) {
    const language = selection === null ? null : memoryLanguage(selection);
    if ((selection !== null && !language) || !Number.isSafeInteger(revision) || Number(revision) < 0)
      throw new HarnessError("invalidInput");
    return this.metadata.transaction(async (tx) => {
      const current = await this.projectLanguage(owner, project, tx);
      if (current.revision !== revision) throw new HarnessError("conflict", 409);
      if (current.language === language) return current;
      const next = { revision: current.revision + 1, language };
      const bucket = namespace(owner, project);
      await save(tx, "memory-language:" + bucket, "project-memory-language", bucket, next);
      return { ...next, inheritedLanguage: current.inheritedLanguage };
    });
  }

  private async effectiveLanguage(owner: string, project: string, reader = this.reader) {
    const preference = await this.projectLanguage(owner, project, reader);
    const language = preference.language ?? preference.inheritedLanguage;
    return { language, revision: `${preference.revision}:${language}` };
  }

  policy(owner: string, projectId: string, reader = this.reader) {
    return reader.get(policyKey(owner, projectId)).then((row) => {
      const policy = decode<MemoryPolicy & { organization?: true }>(row) ?? defaultPolicy;
      const selection = policy.model?.selection ?? null;
      return {
        revision: policy.revision,
        write: policy.write,
        recall: policy.recall,
        model: {
          enabled: "organization" in policy && policy.organization === true && policy.model?.enabled === true,
          selection,
        },
      };
    });
  }

  async configure(owner: string, projectId: string, input: MemoryPolicy) {
    const before = await this.policy(owner, projectId);
    if (input.revision !== before.revision) throw new HarnessError("conflict", 409);
    const model = input.model
      ? { enabled: input.model.enabled, selection: input.model.selection ?? before.model.selection }
      : before.model;
    if (model.enabled && (!before.model.enabled || digest(before.model.selection) !== digest(model.selection))) {
      if (!this.models || !model.selection?.runtimeId) throw new HarnessError("invalidInput");
      model.selection = await this.models.resolve(owner, model.selection);
    }
    return this.metadata.transaction(async (tx) => {
      const prior = await this.policy(owner, projectId, tx);
      if (input.revision !== prior.revision) throw new HarnessError("conflict", 409);
      const next = { write: input.write, recall: input.recall, revision: prior.revision + 1, model };
      await save(tx, policyKey(owner, projectId), policyKind, namespace(owner, projectId), {
        ...next,
        organization: true,
        owner,
        projectId,
      });
      if (next.write || next.recall) await this.search?.dirty(tx, owner, projectId, true);
      return next;
    });
  }

  source(id: string, reader = this.reader) {
    return reader.get(sourceKey(id)).then((record) => decode<SourcePolicy>(record) ?? defaultSource);
  }

  async scope(conversation: MemoryConversation): Promise<ScopedConversation | null> {
    return conversation.memoryPrivate ? null : this.recallScope(conversation);
  }

  async recallScope(conversation: MemoryConversation): Promise<ScopedConversation | null> {
    const membership = conversation.nativeId
      ? await this.legacyMembership?.(conversation.nativeId)
      : this.assignment
        ? await this.assignment(conversation.id)
        : { projectId: conversation.projectId, checkpoint: null };
    if (!membership?.projectId || membership.projectId === "personal") return null;
    if (conversation.nativeId && membership.projectId !== conversation.projectId) return null;
    const checkpoint = conversation.nativeId ? { throughBytes: 0, throughSeq: 0 } : membership.checkpoint;
    return { ...conversation, projectId: membership.projectId, checkpoint };
  }

  async acceptsTurn(id: string, seq: number, reader = this.reader) {
    return automaticMemoryAllowed(await this.source(id, reader), seq);
  }

  async requireScope(conversation: MemoryConversation) {
    const scoped = await this.scope(conversation);
    if (!scoped) throw new HarnessError("notFound", 404);
    await this.authorize(scoped);
    return scoped;
  }

  async configureSource(
    tx: HarnessMetadataTransaction,
    conversation: MemoryConversation,
    input: {
      revision: number;
      write?: boolean | null;
      recall?: boolean | null;
      paused?: boolean;
      revoke: boolean;
      impactToken?: string;
    },
  ) {
    if (conversation.memoryPrivate || !conversation.projectId || conversation.projectId === "personal")
      throw new HarnessError("notFound", 404);
    const prior = await this.source(conversation.id, tx);
    if (input.revision !== prior.revision) throw new HarnessError("conflict", 409);
    if (input.revoke) await this.assertRemovalImpact(tx, conversation, input.impactToken);
    const next: SourcePolicy = {
      ...prior,
      revision: prior.revision + 1,
      write: input.write === undefined ? prior.write : input.write,
      recall: input.recall === undefined ? prior.recall : input.recall,
      generation: prior.generation + Number(input.revoke),
      withdrawnThrough: input.revoke
        ? { throughBytes: conversation.historyBytes, throughSeq: conversation.lastSeq }
        : prior.withdrawnThrough,
    };
    if (input.paused === true && prior.pausedAfterSeq === undefined) next.pausedAfterSeq = conversation.lastSeq;
    if (input.paused === false && prior.pausedAfterSeq !== undefined) {
      const ranges = prior.pausedRanges ?? [];
      const previous = ranges.at(-1);
      const adjacent = previous?.throughSeq === prior.pausedAfterSeq;
      next.pausedRanges = [
        ...(adjacent ? ranges.slice(0, -1) : ranges),
        {
          afterSeq: adjacent ? previous.afterSeq : prior.pausedAfterSeq,
          throughSeq: conversation.lastSeq,
        },
      ];
      delete next.pausedAfterSeq;
    }
    await save(tx, sourceKey(conversation.id), "project-memory-source", conversation.owner, next);
    if (input.revoke) await this.retract(tx, conversation);
    return this.sessionPolicy(next);
  }

  sessionPolicy({ revision, write, recall, generation, pausedAfterSeq }: SourcePolicy) {
    return { revision, write, recall, generation, paused: pausedAfterSeq !== undefined };
  }

  async organizationBoundary(
    tx: HarnessMetadataTransaction,
    conversation: ScopedConversation,
    seq: number,
  ): Promise<MemoryOrganizationBoundary | undefined> {
    if (conversation.memoryPrivate) return;
    const { owner, id: conversationId, projectId, historyBytes: fromBytes, checkpoint } = conversation;
    const policy = await this.policy(owner, projectId, tx);
    const source = await this.source(conversationId, tx);
    if (
      !this.models?.organize ||
      !policy.model.enabled ||
      !policy.model.selection ||
      !(source.write ?? policy.write) ||
      !automaticMemoryAllowed(source, seq) ||
      (checkpoint && seq <= checkpoint.throughSeq)
    )
      return;
    return {
      owner,
      projectId,
      conversationId,
      fromBytes,
      sourceRevision: source.revision,
      policyRevision: policy.revision,
      generation: source.generation,
    };
  }

  private async organizationScope(
    work: MemoryOrganizationBoundary & { throughBytes: number; seq: number },
    reader: Reader,
  ) {
    const conversation = await this.readSource(work.owner, work.projectId, work.conversationId, reader);
    if (
      !conversation ||
      work.throughBytes > conversation.historyBytes ||
      (conversation.checkpoint && work.fromBytes < conversation.checkpoint.throughBytes)
    )
      return null;
    const policy = await this.policy(work.owner, work.projectId, reader);
    const source = await this.source(work.conversationId, reader);
    if (
      !policy.model.enabled ||
      !policy.model.selection ||
      !(source.write ?? policy.write) ||
      !automaticMemoryAllowed(source, work.seq) ||
      policy.revision !== work.policyRevision ||
      source.revision !== work.sourceRevision ||
      source.generation !== work.generation
    )
      return null;
    try {
      await this.authorize(conversation, "contribute");
    } catch (error) {
      if ([403, 404].includes(errorStatus(error)) || ["forbidden", "notFound"].includes(errorCode(error))) return null;
      throw error;
    }
    return policy.model.selection;
  }

  async retract(tx: HarnessMetadataTransaction, conversation: MemoryConversation) {
    const current = await this.scope(conversation);
    if (!current) return;
    const { owner, projectId } = current;
    const bucket = namespace(owner, projectId);
    const raw = await tx.list(evidenceKind, bucket);
    const affected = new Set<string>();
    for (const row of raw) {
      const item = decode<MemoryEvidence>(row)!;
      if (item.conversationId === conversation.id) affected.add(entryId(item.key, item.scope));
    }
    if (!affected.size && !this.models) return;
    if (affected.size) {
      await this.search?.dirty(tx, owner, projectId);
      const { groups } = await this.readProjectEvidence(owner, projectId, tx, {
        rows: raw,
        select: ({ key, scope }) => affected.has(entryId(key, scope)),
      });
      await this.enqueueConflicts(tx, owner, projectId, groups);
      await appendMemoryVersions(tx, bucket, [...affected], groups, this.now(), "withdraw");
    }
    await save(tx, `memory-retract:${conversation.id}`, retractKind, bucket, {
      conversationId: conversation.id,
    });
  }

  private async cleanWithdrawn() {
    const requests = await this.metadata.list(retractKind, undefined, { limit: 8, oldestFirst: true });
    for (const request of requests) {
      const { conversationId } = decode<{ conversationId: string }>(request)!;
      await this.metadata.transaction(async (tx) => {
        if ((await tx.get(request.id))?.revision !== request.revision) return;
        const conversation = decode<MemoryConversation>(await tx.get(conversationKey(conversationId)));
        const source = await this.source(conversationId, tx);
        const evidence = await tx.list(evidenceKind, request.owner);
        const withdrawn = evidence.filter((record) => {
          const item = decode<MemoryEvidence>(record)!;
          return (
            item.conversationId === conversationId &&
            (!conversation || conversation.archivedAt != null || source.generation !== item.generation)
          );
        });
        for (const row of withdrawn.slice(0, 100)) await tx.remove(row.id, row.revision);
        const reviews = (await tx.list(modelReviewKind, request.owner)).filter((row) => {
          const review = decode<MemoryModelReview & { generation: number }>(row)!;
          return (
            review.conversationId === conversationId &&
            (!conversation || conversation.archivedAt != null || review.generation !== source.generation)
          );
        });
        for (const row of reviews.slice(0, 100)) await tx.remove(row.id, row.revision);
        if (withdrawn.length <= 100 && reviews.length <= 100) await tx.remove(request.id, request.revision);
      });
    }
  }

  private async readSource(owner: string, projectId: string, id: string, reader: Reader) {
    const conversation = decode<MemoryConversation>(
      (await reader.get(conversationKey(id))) ?? (await reader.get(nativeMemoryKey(id))),
    );
    if (conversation?.owner !== owner || conversation.archivedAt != null || !this.pathAllowed(conversation.cwd))
      return null;
    const current = await this.scope(conversation);
    return current?.projectId === projectId ? current : null;
  }

  async registeredBackfill(
    owner: string,
    projectId: string,
    id: string,
    request?: { days: 7 | 30; requestId: unknown },
  ) {
    const conversation = await this.readSource(owner, projectId, id, this.reader);
    if (!conversation) throw new HarnessError("notFound", 404);
    await this.authorize(conversation, request ? "contribute" : "read");
    if (!request) return this.backfills.view(conversation);
    const task = await this.backfills.start(conversation, request);
    if (task.state === "queued") this.wake();
    return task;
  }

  private async backfillScope(destination: { owner: string; projectId: string; id: string }, reader: Reader) {
    const { owner, projectId, id } = destination;
    const current = await this.readSource(owner, projectId, id, reader);
    if (!current) return { availability: "forbidden" } as const;
    try {
      await this.authorize(current, "contribute");
    } catch (error) {
      if (["forbidden", "notFound"].includes(errorCode(error)) || [403, 404].includes(errorStatus(error)))
        return { availability: "forbidden" } as const;
      throw error;
    }
    const source = await this.source(id, reader);
    const policy = await this.policy(owner, projectId, reader);
    if (source.pausedAfterSeq !== undefined) return { availability: "paused" } as const;
    if (!(source.write ?? policy.write) || !policy.model.enabled || !policy.model.selection || !this.models?.organize)
      return { availability: "writeDisabled" } as const;
    if (!current.checkpoint || (source.generation > 0 && !source.withdrawnThrough))
      return { availability: "boundaryUnavailable" } as const;
    const lower =
      source.withdrawnThrough && source.withdrawnThrough.throughBytes > current.checkpoint.throughBytes
        ? source.withdrawnThrough
        : current.checkpoint;
    if (lower.throughBytes > current.historyBytes || lower.throughSeq > current.lastSeq)
      return { availability: "boundaryUnavailable" } as const;
    return {
      availability: "available" as const,
      selection: policy.model.selection,
      lower,
      throughBytes: current.historyBytes,
      activeRunId: current.activeRunId,
      generation: source.generation,
      sourceRevision: source.revision,
      policyRevision: policy.revision,
      pausedRanges: source.pausedRanges ?? [],
    };
  }

  private async recordClaims(
    tx: HarnessMetadataTransaction,
    { owner, projectId }: { owner: string; projectId: string },
    turns: readonly RecordedMemoryTurn[],
  ) {
    const bucket = namespace(owner, projectId);
    const affected = new Map<string, { key: string; id: string }>();
    const replaced = new Set<string>();
    let added = 0;
    const languageRevision = turns.find((turn) => turn.languageRevision !== undefined)?.languageRevision;
    if (
      languageRevision !== undefined &&
      languageRevision !== (await this.effectiveLanguage(owner, projectId, tx)).revision
    )
      throw new HarnessError("conflict", 409);
    const expected = new Map(
      turns.flatMap((turn) =>
        [...(turn.expected ? [turn.expected] : []), ...(turn.expectedRelations ?? [])].map(
          ({ id, version }) => [id, version] as const,
        ),
      ),
    );
    if (expected.size) {
      const current = await this.entries(owner, projectId, tx, ({ key, scope }) => expected.has(entryId(key, scope)));
      const versions = new Map(current.map(({ id, version }) => [id, version]));
      if ([...expected].some(([id, version]) => (versions.get(id) ?? null) !== version))
        throw new HarnessError("conflict", 409);
    }
    for (const { job, claims } of turns) {
      for (const claim of claims) {
        const id = digest([owner, projectId, job.messageId, claim.key, claim.scope, claim.value]);
        const prior = decode<MemoryEvidence>(await tx.get(evidenceKey(id)));
        if (prior) {
          const relations = new Map(
            [...(prior.relations ?? []), ...(claim.relations ?? [])].map((link) => [link.target, link]),
          );
          const titleChanged = claim.title !== undefined && claim.title !== prior.title;
          const updatedRelations = claim.relations?.length ? [...relations.values()].slice(-3) : prior.relations;
          if (
            (titleChanged || JSON.stringify(updatedRelations) !== JSON.stringify(prior.relations)) &&
            "generation" in prior &&
            prior.generation === job.generation
          ) {
            await save(tx, evidenceKey(id), evidenceKind, bucket, {
              ...prior,
              ...(claim.title ? { title: claim.title } : {}),
              ...(updatedRelations?.length ? { relations: updatedRelations } : {}),
            });
            const entry = entryId(claim.key, claim.scope);
            affected.set(entry, { key: claim.key, id: entry });
          }
          continue;
        }
        const entry = entryId(claim.key, claim.scope);
        const evidence: MemoryEvidence = {
          ...claim,
          id,
          conversationId: job.conversationId,
          messageId: job.messageId,
          generation: job.generation,
          recordedAt: job.createdAt,
          throughBytes: job.throughBytes,
        };
        await save(tx, evidenceKey(id), evidenceKind, bucket, evidence);
        added++;
        affected.set(entry, { key: claim.key, id: entry });
        if (claim.replaces) {
          const key = `memory-replace:${bucket}:${entry}`;
          const previous = decode<{ order: MemoryOrder }>(await tx.get(key));
          if (!previous || compareMemoryOrder(evidence, previous.order) > 0) {
            replaced.add(entry);
            await save(tx, key, replacementKind, bucket, {
              entry,
              order: { id: evidence.id, recordedAt: evidence.recordedAt },
            });
          }
        }
      }
    }
    if (affected.size) await this.refreshClaims(tx, owner, projectId, affected, replaced);
    return added;
  }

  private async refreshClaims(
    tx: HarnessMetadataTransaction,
    owner: string,
    projectId: string,
    affected: Map<string, { key: string; id: string }>,
    replaced?: Set<string>,
  ) {
    const bucket = namespace(owner, projectId);
    await reserveMemoryPlaces(tx, bucket, [...affected.values()]);
    const { groups } = await this.readProjectEvidence(owner, projectId, tx, {
      select: ({ key, scope }) => affected.has(entryId(key, scope)),
    });
    await this.enqueueConflicts(tx, owner, projectId, groups);
    await this.search?.dirty(tx, owner, projectId);
    await appendMemoryVersions(tx, bucket, [...affected.keys()], groups, this.now(), "learn", replaced);
  }

  async legacyRecords(owner: string, projectId: string, nativeId: string, reader: Reader = this.reader) {
    const rows = await reader.list(evidenceKind, namespace(owner, projectId));
    return rows.flatMap((row) => {
      const entry = decode<MemoryEvidence>(row)!;
      return entry.legacy?.id === nativeId ? [{ key: entry.key, scope: entry.scope, value: entry.value }] : [];
    });
  }

  async saveLegacy(
    owner: string,
    projectId: string,
    legacy: { id: string; cwd: string },
    claims: readonly MemoryManualConvention[],
  ) {
    const bucket = namespace(owner, projectId);
    const records = await this.metadata.transaction(async (tx) => {
      if (!(await this.validLegacy(projectId, legacy))) throw new HarnessError("notFound", 404);
      const affected = new Map<string, { key: string; id: string }>();
      for (const claim of claims) {
        const id = digest([bucket, "legacy-convention", legacy.id, claim.key, claim.scope, claim.value]);
        if (await tx.get(evidenceKey(id))) continue;
        const evidence: MemoryEvidence = { ...claim, id, legacy, replaces: false, recordedAt: this.now() };
        await save(tx, evidenceKey(id), evidenceKind, bucket, evidence);
        const entry = entryId(claim.key, claim.scope);
        affected.set(entry, { key: claim.key, id: entry });
      }
      if (affected.size) await this.refreshClaims(tx, owner, projectId, affected);
      return this.legacyRecords(owner, projectId, legacy.id, tx);
    });
    this.search?.wake();
    return records;
  }

  private async validLegacy(projectId: string, legacy: { id: string; cwd: string }) {
    return this.pathAllowed(legacy.cwd) && (await this.legacyMembership?.(legacy.id))?.projectId === projectId;
  }

  async processPending() {
    await this.cleanWithdrawn();
    if (this.models?.organize) await this.organizations.processNext(this.stopBackfills.signal);
  }

  modelReviews(owner: string, projectId: string) {
    return this.metadata.transaction(async (tx) => {
      const reviews: MemoryModelReview[] = [];
      const rows = await tx.list(modelReviewKind, namespace(owner, projectId), { limit: 32 });
      for (const row of rows) {
        if (row.updatedAt <= this.now()) continue;
        const { generation, ...review } = decode<MemoryModelReview & { generation: number }>(row)!;
        const source = await this.readSource(owner, projectId, review.conversationId, tx);
        if (!source || (await this.source(source.id, tx)).generation !== generation) continue;
        try {
          await this.authorize(source);
          reviews.push(review);
        } catch {}
      }
      return reviews;
    });
  }

  catalog(owner: string, projectId: string, history = false) {
    return this.metadata.transaction(async (tx) => {
      const { evidence, groups, dismissed } = await this.readProjectEvidence(owner, projectId, tx);
      const current = projectMemories(groups);
      if (!history) return current;
      for (const [id, group] of groupMemoryEvidence(evidence, new Map())) {
        if (groups.has(id) || dismissed.has(id)) continue;
        const first = group[0]!;
        current.push({
          id,
          key: first.key,
          scope: first.scope,
          state: "withdrawn",
          value: null,
          version: null,
          sources: [],
        });
      }
      return current;
    });
  }

  terrain(
    owner: string,
    projectId: string,
    topic?: string,
    plate?: string,
    options?: Parameters<typeof readMemoryTerrain>[6],
  ) {
    void this.discoverProjectConflicts(owner, projectId);
    return this.metadata.transaction(async (tx) => {
      const { groups } = await this.readProjectEvidence(owner, projectId, tx);
      const entries = projectMemories(groups).filter(({ state }) => state === "active");
      return readMemoryTerrain(tx, namespace(owner, projectId), entries, groups, topic, plate, options);
    });
  }

  private organizerEntries(owner: string, projectId: string) {
    return this.metadata.transaction(async (tx) => {
      const { groups } = await this.readProjectEvidence(owner, projectId, tx);
      const entries = projectMemories(groups).slice(0, 80);
      const active = new Map(entries.filter(({ state }) => state === "active").map((item) => [item.id, item]));
      const links = organizedMemoryLinks(active, groups);
      return entries.map(({ id, key, scope, title, value, version }) => ({
        key,
        scope,
        title,
        value,
        version,
        relations: links
          .get(id)
          ?.slice(0, 3)
          .map(({ to, kind }) => {
            const target = active.get(to)!;
            return { key: target.key, scope: target.scope, kind };
          }),
      }));
    });
  }

  private async entries(owner: string, projectId: string, reader: Reader, select?: EntrySelector) {
    const { groups } = await this.readProjectEvidence(owner, projectId, reader, { select });
    return projectMemories(groups);
  }

  private async readProjectEvidence(
    owner: string,
    projectId: string,
    reader: Reader,
    options: { rows?: HarnessRecord[]; select?: EntrySelector } = {},
  ) {
    const bucket = namespace(owner, projectId);
    const rows = options.rows ?? (await reader.list(evidenceKind, bucket));
    const replacements = new Map(
      (await reader.list(replacementKind, bucket)).map((row) => {
        const { entry, order } = decode<{ entry: string; order: MemoryOrder }>(row)!;
        return [entry, order] as const;
      }),
    );
    const generations = new Map<string, number | null>();
    const legacyAccess = new Map<string, boolean>();
    const eligible: MemoryEvidence[] = [];
    for (const row of rows) {
      const evidence = decode<MemoryEvidence>(row)!;
      if (options.select && !options.select(evidence)) continue;
      if (!evidence.conversationId) {
        if (evidence.legacy) {
          const key = JSON.stringify(evidence.legacy);
          if (!legacyAccess.has(key)) legacyAccess.set(key, await this.validLegacy(projectId, evidence.legacy));
          if (legacyAccess.get(key)) eligible.push(evidence);
        } else if (evidence.packageId) eligible.push(evidence);
        continue;
      }
      if (!generations.has(evidence.conversationId)) {
        const current = await this.readSource(owner, projectId, evidence.conversationId, reader);
        generations.set(
          evidence.conversationId,
          current ? (await this.source(evidence.conversationId, reader)).generation : null,
        );
      }
      if (generations.get(evidence.conversationId) === evidence.generation) eligible.push(evidence);
    }
    const resolutions = new Map(
      (await reader.list(resolvedConflictKind, bucket)).map((row) => {
        const { entry, ...resolution } = decode<MemoryResolution & { entry: string }>(row)!;
        return [entry, resolution] as const;
      }),
    );
    return { evidence: eligible, ...applyMemoryResolutions(groupMemoryEvidence(eligible, replacements), resolutions) };
  }

  private async teamPreviewOrigin(owner: string, project: string, id: string, reader: Reader) {
    const { groups } = await this.readProjectEvidence(owner, project, reader, {
      select: ({ key, scope }) => entryId(key, scope) === id,
    });
    const group = groups.get(id);
    if (!group?.length) return null;
    const entry = describeMemory(id, group);
    if (entry.state !== "active" || entry.value === null) return null;
    const merged = group[0]!.projectedFrom !== undefined;
    const merge = merged
      ? digest([entry.value, [...new Set(group.map(({ projectedFrom }) => projectedFrom))].sort()])
      : undefined;
    const candidates = group
      .filter((item) => !!item.conversationId)
      .sort((left, right) => left.id.localeCompare(right.id));
    const proofSources = merged
      ? [...new Map(candidates.map((item) => [item.projectedFrom, item])).values()]
      : candidates;
    const proofs = proofSources
      .slice(0, 8)
      .map((item) => ({ id: item.id, generation: item.generation!, ...(merge ? { merge } : {}) }));
    if (!(await this.teamCurrentOrigin(owner, project, id, proofs, reader))) return null;
    return { key: entry.key, scope: entry.scope, value: entry.value, proofs };
  }

  private async teamCurrentOrigin(owner: string, project: string, entry: string, proofs: TeamProof[], reader: Reader) {
    const bucket = namespace(owner, project);
    const replacement = decode<{ order: MemoryOrder }>(await reader.get(`memory-replace:${bucket}:${entry}`));
    const resolution = await reader.get(memoryResolutionKey(bucket, entry));
    const projected =
      resolution?.kind === resolvedConflictKind
        ? ((
            await this.readProjectEvidence(owner, project, reader, {
              select: ({ key, scope }) => entryId(key, scope) === entry,
            })
          ).groups.get(entry) ?? [])
        : undefined;
    const resolvedProofs = projected ? new Set(projected.map(({ id }) => id)) : null;
    const merged = projected?.[0]?.projectedFrom !== undefined;
    const included = new Set<string>();
    const required = merged ? [...new Set(projected!.map(({ projectedFrom }) => projectedFrom!))].sort() : [];
    const merge = merged ? digest([projected![0]!.value, required]) : undefined;
    if (proofs.some((proof) => proof.merge !== merge)) return null;
    for (const proof of proofs) {
      const row = await reader.get(evidenceKey(proof.id));
      if (row?.kind !== evidenceKind || row.owner !== bucket || (resolvedProofs && !resolvedProofs.has(proof.id)))
        continue;
      const item = decode<MemoryEvidence>(row)!;
      if (
        !item.conversationId ||
        item.generation !== proof.generation ||
        entryId(item.key, item.scope) !== entry ||
        (replacement && replacement.order.recordedAt > item.recordedAt)
      )
        continue;
      const source = await this.readSource(owner, project, item.conversationId, reader);
      if (
        !source ||
        (item.throughBytes !== undefined && item.throughBytes > source.historyBytes) ||
        (await this.source(source.id, reader)).generation !== proof.generation
      )
        continue;
      try {
        await this.authorize(source, "contribute");
      } catch (error) {
        if (["forbidden", "notFound"].includes(errorCode(error)) || [403, 404].includes(errorStatus(error)))
          return null;
        throw error;
      }
      if (!merged) return { key: item.key, scope: item.scope, value: item.value };
      included.add(item.value);
    }
    if (!merged || !required.every((value) => included.has(value))) return null;
    const { key, scope, value } = projected![0]!;
    return { key, scope, value };
  }

  async teamView(owner: string, project: string, canPublish: boolean) {
    return this.metadata.transaction(async (tx) => {
      const view = await this.team.catalog(project, tx, { publisher: owner });
      return { ...view, entries: view.entries.filter(({ state }) => state === "active"), canPublish };
    });
  }

  async exportCitations(owner: string, project: string) {
    return this.metadata.transaction(async (tx) => {
      const { groups } = await this.readProjectEvidence(owner, project, tx);
      const archive = createMemoryArchive(archiveRecords(groups), this.now());
      return archive.records.map(({ key, scope }) => ({ key, scope }));
    });
  }

  async exportArchive(owner: string, project: string, materials?: MemoryPackageMaterial[]) {
    return this.metadata.transaction(async (tx) => {
      const bucket = namespace(owner, project);
      const { groups } = await this.readProjectEvidence(owner, project, tx);
      const archive = createMemoryArchive(archiveRecords(groups), this.now());
      if (materials?.some((material) => material.anchors?.length)) {
        const available = new Set(archive.records.map(memoryMaterialCitationId));
        if (
          materials.some((material) =>
            material.anchors?.some((anchor) => !available.has(memoryMaterialCitationId(anchor))),
          )
        )
          throw new HarnessError("conflict", 409);
      }
      await save(tx, archiveGrantKey(archive.packageId), archiveGrantKind, bucket, {
        owner,
        project,
        checksum: archive.checksum,
        ...(materials
          ? {
              materialDigest: materialDigest(materials),
              sources: materials.map(({ id, kind, version }) => ({ id, kind, version })),
            }
          : {}),
      } satisfies MemoryArchiveGrant);
      return archive;
    });
  }

  async archiveImports(owner: string, project: string) {
    const rows = await this.metadata.list(archiveImportKind, namespace(owner, project), { limit: 30 });
    return rows.map((row) => importSummary(decode<MemoryArchiveReceipt>(row)!));
  }

  async archiveImport(
    owner: string,
    project: string,
    input: unknown,
    token: string | undefined,
    authorize: MemoryArchiveAuthorize,
    assertStaged?: (tx: HarnessMetadataTransaction) => void | Promise<void>,
    media?: {
      materials: MemoryPackageMaterial[];
      assertCurrent(owner: string, project: string, source: MemoryMaterialSelection): Promise<void>;
    },
  ) {
    const archive = parseMemoryArchive(input);
    const mediaDigest = media && materialDigest(media.materials);
    const bucket = namespace(owner, project);
    const key = archiveImportKey(bucket, archive.packageId);
    return this.metadata.transaction(async (tx) => {
      await authorize(owner, project, "contribute");
      await assertStaged?.(tx);
      const receipt = decode<MemoryArchiveReceipt>(await tx.get(key)) ?? undefined;
      if (receipt && (receipt.checksum !== archive.checksum || receipt.materialDigest !== mediaDigest))
        throw new HarnessError("conflict", 409);
      if (token !== undefined && receipt) {
        if (receipt.withdrawn) throw new HarnessError("conflict", 409);
        return importSummary(receipt);
      }
      const { groups } = await this.readProjectEvidence(owner, project, tx);
      const grant = decode<MemoryArchiveGrant>(await tx.get(archiveGrantKey(archive.packageId)));
      if (grant && !receipt) {
        if (grant.owner !== owner) throw new HarnessError("forbidden", 403);
        if (grant.checksum !== archive.checksum || grant.materialDigest !== mediaDigest)
          throw new HarnessError("conflict", 409);
        await authorize(owner, grant.project);
        for (const source of grant.sources ?? []) await media!.assertCurrent(owner, grant.project, source);
        const origin =
          grant.project === project ? { groups } : await this.readProjectEvidence(owner, grant.project, tx);
        assertArchiveOrigin(archive, archiveRecords(origin.groups));
      }
      const { preview, changes } = prepareArchiveImport(bucket, archive, groups, receipt);
      if (mediaDigest) preview.token = digest([preview.token, mediaDigest]);
      if (media) preview.materials = media.materials;
      if (token === undefined) return preview;
      if (preview.token !== token) throw new HarnessError("conflict", 409);

      const importedAt = this.now();
      const affected: Array<{ id: string; key: string }> = [];
      for (const { key, scope, values } of changes) {
        affected.push({ id: entryId(key, scope), key });
        for (const value of values) {
          const id = digest([bucket, archive.packageId, key, scope, value]);
          const row: MemoryEvidence = {
            id,
            key,
            scope,
            value,
            replaces: false,
            packageId: archive.packageId,
            recordedAt: importedAt,
          };
          await save(tx, evidenceKey(id), evidenceKind, bucket, row);
        }
      }
      const summary: MemoryArchiveImport = {
        packageId: archive.packageId,
        added: preview.added,
        conflict: preview.conflict,
        duplicate: preview.duplicate,
        invalid: preview.invalid,
        importedAt,
        withdrawn: false,
        ...(media ? { materials: media.materials } : {}),
      };
      const imported: MemoryArchiveReceipt = { ...summary, checksum: archive.checksum, materialDigest: mediaDigest };
      await save(tx, key, archiveImportKind, bucket, imported);
      await this.materialSearch?.enqueue(tx, owner, project, imported);
      if (affected.length) {
        await this.refreshClaims(tx, owner, project, new Map(affected.map((item) => [item.id, item])));
      }
      return summary;
    });
  }

  async archiveImportRecord(owner: string, project: string, packageId: string) {
    const receipt = decode<MemoryArchiveReceipt>(
      await this.metadata.read(archiveImportKey(namespace(owner, project), packageId)),
    );
    if (!receipt || receipt.withdrawn) throw new HarnessError("notFound", 404);
    return importSummary(receipt);
  }

  async archiveMaterialSource(owner: string, project: string, packageId: string, id: string) {
    const receipt = decode<MemoryArchiveReceipt>(
      await this.metadata.read(archiveImportKey(namespace(owner, project), packageId)),
    );
    const material = receipt?.materials?.find((item) => item.id === id);
    if (!material || receipt?.withdrawn || !receipt?.materialDigest) throw new HarnessError("notFound", 404);
    return { checksum: receipt.materialDigest, material };
  }

  async archiveMaterial(owner: string, project: string, packageId: string, id: string, digest: string, name: string) {
    const { checksum, material } = await this.archiveMaterialSource(owner, project, packageId, id);
    const file = memoryMaterialOriginals(material).find((item) => item.digest === digest && item.name === name);
    if (!file) throw new HarnessError("notFound", 404);
    return { checksum, file, kind: material.kind };
  }

  async withdrawArchive(owner: string, project: string, id: string, authorize?: MemoryArchiveAuthorize) {
    return this.metadata.transaction(async (tx) => {
      await authorize?.(owner, project, "contribute");
      const bucket = namespace(owner, project);
      const key = archiveImportKey(bucket, id);
      const receipt = decode<MemoryArchiveReceipt>(await tx.get(key));
      if (!receipt) throw new HarnessError("notFound", 404);
      if (receipt.withdrawn) return importSummary(receipt);
      const affected = new Set<string>();
      for (const row of await tx.list(evidenceKind, bucket)) {
        const item = decode<MemoryEvidence>(row)!;
        if (item.packageId !== id) continue;
        affected.add(entryId(item.key, item.scope));
        await tx.remove(row.id, row.revision);
      }
      receipt.withdrawn = true;
      await save(tx, key, archiveImportKind, bucket, receipt);
      await this.materialSearch?.withdraw(tx, owner, project, receipt);
      if (affected.size) {
        const { groups } = await this.readProjectEvidence(owner, project, tx);
        await this.enqueueConflicts(tx, owner, project, groups, affected);
        await this.search?.dirty(tx, owner, project);
        await appendMemoryVersions(tx, bucket, [...affected], groups, this.now(), "withdraw");
      }
      return importSummary(receipt);
    });
  }

  async sourceLocation(
    owner: string,
    projectId: string,
    conversationId: string,
    messageId: string,
  ): Promise<MemorySourceLocation> {
    const locate = async (tx: HarnessMetadataTransaction) => {
      const source = await this.readSource(owner, projectId, conversationId, tx);
      if (!source) return null;
      const generation = (await this.source(conversationId, tx)).generation;
      const evidence = await tx.list(evidenceKind, namespace(owner, projectId));
      for (const row of evidence) {
        const item = decode<MemoryEvidence>(row)!;
        if (item.conversationId === conversationId && item.messageId === messageId && item.generation === generation)
          return { source, item };
      }
      return null;
    };
    const evidence = await this.metadata.transaction(locate);
    if (!evidence) throw new HarnessError("notFound", 404);
    await this.authorize(evidence.source);
    const message = await this.history.messageAt(owner, conversationId, evidence.source.historyBytes, evidence.item);
    if (!message || message.role !== "user") throw new HarnessError("notFound", 404);

    const current = await this.metadata.transaction(async (tx) => {
      const source = await this.readSource(owner, projectId, conversationId, tx);
      if (!source || (await this.source(conversationId, tx)).generation !== evidence.item.generation) return null;
      return (await tx.get(evidenceKey(evidence.item.id))) ? source : null;
    });
    if (!current) throw new HarnessError("notFound", 404);
    await this.authorize(current);
    return {
      title: current.title ?? null,
      ...(current.nativeId ? { nativeConversationId: current.nativeId } : {}),
      message: {
        id: message.id,
        text: visibleHarnessText(message.text),
        createdAt: message.createdAt,
        sequence: message.seq,
      },
    };
  }

  async sourceMessage(owner: string, projectId: string, conversationId: string, messageId: string) {
    const { message } = await this.sourceLocation(owner, projectId, conversationId, messageId);
    return { text: message.text };
  }

  async detail(owner: string, projectId: string, id: string, before?: number) {
    return this.metadata.transaction(async (tx) => {
      const {
        evidence: visible,
        groups,
        dismissed,
      } = await this.readProjectEvidence(owner, projectId, tx, {
        select: ({ key, scope }) => entryId(key, scope) === id,
      });
      const current = groups.get(id) ?? [];
      if (!visible.length || dismissed.has(id) || (current.length && describeMemory(id, current).state === "conflict"))
        throw new HarnessError("notFound", 404);
      const detail = await readMemoryDetail(
        tx,
        namespace(owner, projectId),
        id,
        current,
        new Map(visible.map((row) => [row.id, row])),
        before,
      );
      if (!detail.current && !detail.versions.length && detail.next === null) throw new HarnessError("notFound", 404);
      return {
        ...detail,
        versions: detail.versions.filter(({ reason, entry }) => reason !== "conflict" && entry?.state !== "conflict"),
      };
    });
  }

  async removalImpact(conversation: MemoryConversation, reader?: Reader): Promise<MemoryRemovalImpact> {
    const projectId = conversation.projectId;
    if (!projectId || projectId === "personal") throw new HarnessError("notFound", 404);
    if (!reader)
      return this.metadata.transaction(async (tx) => {
        const current = await this.readSource(conversation.owner, projectId, conversation.id, tx);
        if (!current) throw new HarnessError("notFound", 404);
        return this.removalImpact(current, tx);
      });
    const source = await this.source(conversation.id, reader);
    const { groups: before } = await this.readProjectEvidence(conversation.owner, projectId, reader);
    const impact = { stops: 0, retains: 0, recovers: 0, pauses: 0 };
    const revisions: string[][] = [];
    for (const [id, group] of before) {
      const survivors = group.filter((row) => row.conversationId !== conversation.id);
      if (survivors.length === group.length) continue;
      revisions.push(group.map((row) => row.id).sort());
      if (!survivors.length) impact.stops++;
      else if (describeMemory(id, survivors).state === "conflict") impact.pauses++;
      else if (describeMemory(id, group).state === "conflict") impact.recovers++;
      else impact.retains++;
    }
    revisions.sort((left, right) => left[0]!.localeCompare(right[0]!));
    return {
      ...impact,
      token: digest([conversation.id, conversation.revision, source.revision, revisions]),
    };
  }

  async assertRemovalImpact(tx: HarnessMetadataTransaction, conversation: MemoryConversation, token?: string) {
    if (!token) return;
    const scoped = await this.scope(conversation);
    if (!scoped || (await this.removalImpact(scoped, tx)).token !== token) throw new HarnessError("conflict", 409);
  }

  async bindingIsCurrent(conversation: MemoryConversation, references: readonly MemoryRecall[], reader = this.reader) {
    if (!references.length) return true;
    const scoped = await this.recallScope(conversation).catch(() => null);
    if (!scoped || !(await this.recallAllowed(scoped, scoped.projectId, reader))) return false;
    const { projectId } = scoped;
    if (references.some((reference) => reference.projectId !== undefined && reference.projectId !== projectId))
      return false;
    try {
      await this.authorize(scoped);
    } catch {
      return false;
    }
    const { privateIds, teamIds } = referenceIds(references);
    const current =
      privateIds.size || teamIds.size
        ? await this.team.catalog(projectId, reader, { privateIds, teamIds }).catch(() => null)
        : { entries: [] };
    if (!current) return false;
    for (const entry of current.entries) if (teamIds.has(entry.id)) privateIds.add(entryId(entry.key, entry.scope));
    const privateEntries = privateIds.size
      ? await this.entries(conversation.owner, projectId, reader, ({ key, scope }) =>
          privateIds.has(entryId(key, scope)),
        )
      : [];
    const entries = compatibleProjectMemory(privateEntries, current.entries);
    for (const reference of references) {
      if (!reference.material) continue;
      const current = await this.materialSearch?.current(conversation.owner, projectId, reference.id, reader);
      if (current?.version !== reference.version || current.packageId !== reference.material.packageId) return false;
    }
    return references.every(
      (reference) =>
        reference.material ||
        (reference.team
          ? entries.some((entry) => entry.team && entry.id === reference.id && entry.version === reference.version)
          : entries.some(
              (entry) =>
                entry.id === reference.id &&
                entry.version === reference.version &&
                (reference.packages ?? []).every((id) => entry.packages?.includes(id)) &&
                (reference.manual ?? []).every((id) => entry.manual?.includes(id)) &&
                reference.sources.every((source) =>
                  entry.sources.some(
                    (candidate) =>
                      candidate.conversationId === source.conversationId && candidate.messageId === source.messageId,
                  ),
                ),
            )),
    );
  }

  private async recallAllowed(conversation: MemoryConversation, projectId: string, reader: Reader) {
    const { recall, pausedAfterSeq } = await this.source(conversation.id, reader);
    return (
      pausedAfterSeq === undefined && (recall ?? (await this.policy(conversation.owner, projectId, reader)).recall)
    );
  }

  async prepareRecall(conversation: MemoryConversation, text: string): Promise<MemoryCandidates | undefined> {
    if (!this.search || !text.trim()) return;
    try {
      const scoped = await this.recallScope(conversation);
      if (!scoped || !(await this.recallAllowed(scoped, scoped.projectId, this.reader))) return;
      await this.authorize(scoped);
      const [conventions, materials] = await Promise.all([
        this.search.lookup(scoped.owner, scoped.projectId, text),
        this.materialSearch?.lookup(scoped.owner, scoped.projectId, text).catch(() => undefined),
      ]);
      return { projectId: scoped.projectId, ...conventions, materials };
    } catch {
      return;
    }
  }

  indexStatus(owner: string, project: string) {
    return this.search?.status(owner, project);
  }

  async rebuildIndex(owner: string, project: string) {
    if (!this.search) throw new HarnessError("unavailable", 503);
    await Promise.all([this.search.ensure(owner, project, true), this.materialSearch?.rebuild(owner, project)]);
    return this.search.status(owner, project);
  }

  async find(owner: string, project: string, query: string) {
    void this.discoverProjectConflicts(owner, project);
    if (!query || !this.search)
      return (await this.catalog(owner, project, true)).filter(
        ({ state, key, scope, title }) =>
          state !== "conflict" && (!query || [key, scope, title].some((text) => text?.toLowerCase().includes(query))),
      );
    const { hits, salt } = await this.search.lookup(owner, project, query, 1400);
    if (!hits.size || !salt) return [];
    const entries = await this.metadata.transaction((tx) =>
      this.entries(owner, project, tx, ({ key, scope }) => hits.has(entryId(key, scope))),
    );
    const active = new Map(entries.map((item) => [item.id, item]));
    return [...hits].flatMap(([id, version]) => {
      const item = active.get(id);
      return item?.version && version === indexedMemoryVersion(salt, item.version) ? [item] : [];
    });
  }

  async recall(
    tx: HarnessMetadataTransaction,
    conversation: MemoryConversation,
    text: string,
    existing: readonly MemoryRecall[],
    candidates?: MemoryCandidates,
    precedingUserMessages: readonly string[] = [],
  ) {
    const matchesPrompt = projectMemoryMatcher(text);
    if (!matchesPrompt) return [];
    const personal = personalRecallMatches(text, precedingUserMessages);
    const scoped = await this.recallScope(conversation).catch(() => null);
    if (!scoped || !(await this.recallAllowed(scoped, scoped.projectId, tx))) return [];
    const { projectId } = scoped;
    if (candidates && candidates.projectId !== projectId) return [];
    try {
      await this.authorize(scoped);
      const { entries: shared } = await this.team.catalog(projectId, tx, { matches: matchesPrompt });
      if (!personal && this.search && !shared.length && (!candidates?.hits.size || !candidates.salt)) return [];
      const entries = await this.entries(
        conversation.owner,
        projectId,
        tx,
        (entry) =>
          matchesMemoryEntry(entry, matchesPrompt) ||
          candidates?.hits.has(entryId(entry.key, entry.scope)) ||
          (personal?.(entry) ?? -1) >= 0,
      );
      const allowed = compatibleProjectMemory(entries, shared);
      const matches = (entry: MemoryEntry) =>
        entry.team ||
        !this.search ||
        (!!entry.version &&
          !!candidates?.salt &&
          candidates.hits.get(entry.id) === indexedMemoryVersion(candidates.salt, entry.version));
      const seen = new Set<string>();
      return matchingMemories(allowed, matchesPrompt, conversation.id, matches, personal, existing)
        .filter((entry) => {
          const key = entryId(entry.key, entry.scope);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((entry) => ({ ...entry, projectId }));
    } catch {
      return [];
    }
  }

  async recallMaterials(
    conversation: MemoryConversation,
    text: string,
    existing: readonly MemoryRecall[],
    candidates?: MemoryCandidates,
    reader: Reader = this.reader,
  ) {
    if (!this.materialSearch || !candidates?.materials?.hits.size) return [];
    const scoped = await this.recallScope(conversation).catch(() => null);
    if (
      !scoped ||
      scoped.projectId !== candidates.projectId ||
      !(await this.recallAllowed(scoped, scoped.projectId, reader))
    )
      return [];
    try {
      await this.authorize(scoped);
      const matches = await this.materialSearch.results(
        scoped.owner,
        scoped.projectId,
        text,
        candidates.materials,
        reader,
        3,
        (id, version) => existing.some((reference) => reference.id === id && reference.version === version),
      );
      return matches.filter(({ material, file }) => !memoryCredentialPattern.test(material.title + " " + file.name));
    } catch {
      return [];
    }
  }

  async findMaterials(owner: string, project: string, query: string) {
    if (!query || !this.materialSearch) return undefined;
    try {
      return await this.materialSearch.find(owner, project, query, this.reader);
    } catch {
      return { state: "unavailable" as const, hits: [] };
    }
  }

  async recordRecall(tx: HarnessMetadataTransaction, conversation: MemoryConversation, receipt: MemoryReceipt) {
    await save(tx, recallKey(receipt.runId), recallKind, conversation.id, receipt);
  }

  async confirmRecall(tx: HarnessMetadataTransaction, conversation: MemoryConversation, runId: string) {
    const receipt = decode<MemoryReceipt>(await tx.get(recallKey(runId)));
    if (receipt?.status === "possible") await this.recordRecall(tx, conversation, { ...receipt, status: "sent" });
  }

  async retryFailed(conversation: MemoryConversation) {
    if (!conversation.projectId) throw new HarnessError("notFound", 404);
    const projectId = conversation.projectId;
    return this.metadata.transaction(async (tx) => {
      const current = await this.readSource(conversation.owner, projectId, conversation.id, tx);
      if (!current) throw new HarnessError("notFound", 404);
      const source = await this.source(conversation.id, tx);
      const policy = await this.policy(conversation.owner, projectId, tx);
      if (source.pausedAfterSeq !== undefined || !(source.write ?? policy.write))
        throw new HarnessError("conflict", 409);
      return { retried: await this.organizations.retry(tx, conversation.id) };
    });
  }

  async contributions(conversation: MemoryConversation) {
    if (!conversation.projectId) return { entries: [], pending: 0, failed: 0 };
    const projectId = conversation.projectId;
    return this.metadata.transaction(async (tx) => {
      const current = await this.readSource(conversation.owner, projectId, conversation.id, tx);
      if (!current) throw new HarnessError("notFound", 404);
      const source = await this.source(conversation.id, tx);
      const policy = await this.policy(conversation.owner, projectId, tx);
      const { pending, failed } = await this.organizations.status(tx, {
        conversationId: conversation.id,
        generation: source.generation,
        sourceRevision: source.revision,
        policyRevision: policy.revision,
      });
      const entries = (await this.entries(conversation.owner, projectId, tx)).filter(
        (entry) => entry.state === "active" && entry.sources.some((item) => item.conversationId === conversation.id),
      );
      return { entries, pending, failed };
    });
  }

  async recalls(conversation: MemoryConversation) {
    if (!conversation.projectId || conversation.projectId === "personal") return [];
    const projectId = conversation.projectId;
    return this.metadata.transaction(async (tx) => {
      const current = await this.readSource(conversation.owner, projectId, conversation.id, tx);
      if (!current) throw new HarnessError("notFound", 404);
      const rows = (await tx.list(recallKind, conversation.id, { limit: 40 })).map((row) =>
        decode<MemoryReceipt>(row)!,
      );
      const { privateIds, teamIds } = referenceIds(rows.flatMap((receipt) => receipt.references));
      const entries = privateIds.size
        ? await this.entries(conversation.owner, projectId, tx, ({ key, scope }) => privateIds.has(entryId(key, scope)))
        : [];
      const team = teamIds.size
        ? ((await this.team.catalog(projectId, tx, { teamIds }).catch(() => null))?.entries ?? [])
        : [];
      return Promise.all(
        rows.map(async ({ runId, status, references }) => {
          const authorized = await Promise.all(
            references.map(async (reference): Promise<MemoryRecall | null> => {
              if (reference.material) {
                const current = await this.materialSearch?.current(conversation.owner, projectId, reference.id, tx);
                return current?.version === reference.version ? reference : null;
              }
              if (reference.team)
                return team.some((item) => item.id === reference.id && item.version === reference.version)
                  ? { id: reference.id, version: reference.version, sources: [], team: true }
                  : null;
              const entry = entries.find(
                (candidate) => candidate.id === reference.id && candidate.version === reference.version,
              );
              const sources = reference.sources.filter((source) =>
                entry?.sources.some(
                  (candidate) =>
                    candidate.conversationId === source.conversationId && candidate.messageId === source.messageId,
                ),
              );
              const packages = (reference.packages ?? []).filter((id) => entry?.packages?.includes(id));
              const manual = (reference.manual ?? []).filter((id) => entry?.manual?.includes(id));
              return sources.length || packages.length || manual.length
                ? {
                    id: reference.id,
                    version: reference.version,
                    sources,
                    ...(packages.length ? { packages } : {}),
                    ...(manual.length ? { manual } : {}),
                  }
                : null;
            }),
          );
          return { runId, status, references: authorized.filter((reference) => reference !== null) };
        }),
      );
    });
  }
}
