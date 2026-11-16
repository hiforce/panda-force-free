import type { SavedSourceKind } from "../../../shared/content-sources/contracts.js";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  GenerationLease,
  GenerationSnapshot,
  StoredGenerationPolicy,
  KnowledgeGenerationJobStore,
} from "../generation/contracts.js";
import type { KnowledgeTaskStore } from "../tasks/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import {
  cancelGeneratedTasks,
  generationLeaseCurrent,
  scheduleGenerationScope,
  generationSnapshotSources,
} from "./generation-common.js";

interface Job {
  sourceKind: SavedSourceKind;
  documentId: string;
  version: string;
  state: string;
  failures: number;
}
interface Candidate extends Job {
  owner: string;
  project: string;
  policyRevision: number;
  operationId: string;
}
/** A saved source has one desired version. Repeated saves replace queued work without erasing immutable task history. */
export class KnowledgeGenerationQueue implements KnowledgeGenerationJobStore {
  constructor(
    private db: Database,
    private tasks: Pick<KnowledgeTaskStore, "cancel">,
  ) {}
  reconcile(policy: StoredGenerationPolicy, snapshot: GenerationSnapshot, now: number) {
    const matched = generationSnapshotSources(snapshot);
    return this.db
      .transaction(() => {
        if (
          !this.db
            .query(
              "SELECT 1 FROM knowledge_generation_policies WHERE owner=? AND project=? AND enabled=1 AND revision=? AND observedCommit IS ?",
            )
            .get(policy.owner, policy.project, policy.revision, policy.observedCommit)
        )
          throw new KnowledgeTaskError("conflict");
        const prior = new Map(
            this.db
              .query<Job, [string, string]>(
                "SELECT documentId,version,state,failures,sourceKind FROM knowledge_generation_jobs WHERE owner=? AND project=?",
              )
              .all(policy.owner, policy.project)
              .map((row) => [row.documentId, row]),
          ),
          cancelled: string[] = [];
        for (const doc of matched) {
          const old = prior.get(doc.id);
          prior.delete(doc.id);
          if (old && old.sourceKind === doc.kind && old.version === doc.version && old.state !== "excluded") continue;
          cancelled.push(
            ...cancelGeneratedTasks(this.db, this.tasks, policy.owner, policy.project, now, {
              id: doc.id,
              kind: old?.sourceKind ?? doc.kind,
            }),
          );
          this.db
            .query(
              `INSERT INTO knowledge_generation_jobs(owner,project,documentId,version,policyRevision,operationId,state,token,leaseUntil,notBefore,failures,taskId,updatedAt,sourceKind) VALUES(?,?,?,?,?,?,'queued',NULL,NULL,?,0,NULL,?,?)
          ON CONFLICT(owner,project,documentId) DO UPDATE SET version=excluded.version,sourceKind=excluded.sourceKind,policyRevision=excluded.policyRevision,
          operationId=excluded.operationId,state='queued',token=NULL,leaseUntil=NULL,notBefore=excluded.notBefore,
          failures=0,taskId=NULL,updatedAt=excluded.updatedAt`,
            )
            .run(
              policy.owner,
              policy.project,
              doc.id,
              doc.version,
              policy.revision,
              randomUUID(),
              now + 1500,
              now,
              doc.kind,
            );
        }
        for (const doc of prior.values()) {
          if (doc.state === "excluded") continue;
          cancelled.push(
            ...cancelGeneratedTasks(this.db, this.tasks, policy.owner, policy.project, now, {
              id: doc.documentId,
              kind: doc.sourceKind,
            }),
          );
          this.db
            .query("DELETE FROM knowledge_generation_jobs WHERE owner=? AND project=? AND documentId=?")
            .run(policy.owner, policy.project, doc.documentId);
        }
        this.db
          .query("UPDATE knowledge_generation_policies SET observedCommit=? WHERE owner=? AND project=? AND revision=?")
          .run(snapshot.commit, policy.owner, policy.project, policy.revision);
        scheduleGenerationScope(this.db, policy.owner, policy.project, now);
        return cancelled;
      })
      .immediate();
  }
  claim(now: number): GenerationLease | null {
    return this.db
      .transaction(() => {
        const policy = this.db
          .query<{ owner: string; project: string; revision: number; purpose: string }, [number]>(
            `SELECT owner,project,revision,purpose FROM knowledge_generation_policies
         WHERE enabled=1 AND scanFailures=0 AND nextAdmissionAt<=? ORDER BY nextAdmissionAt,owner,project LIMIT 1`,
          )
          .get(now);
        if (!policy) return null;
        const expired = this.db
            .query<Candidate, [string, string, number, number]>(
              `SELECT * FROM knowledge_generation_jobs WHERE owner=? AND project=? AND policyRevision=?
         AND state='claimed' AND leaseUntil<=? AND failures<3 ORDER BY leaseUntil,updatedAt,documentId LIMIT 1`,
            )
            .get(policy.owner, policy.project, policy.revision, now),
          row =
            expired ??
            this.db
              .query<Candidate, [string, string, number, number]>(
                `SELECT * FROM knowledge_generation_jobs WHERE owner=? AND project=? AND policyRevision=?
           AND state='queued' AND notBefore<=? AND failures<3 ORDER BY notBefore,updatedAt,documentId LIMIT 1`,
              )
              .get(policy.owner, policy.project, policy.revision, now);
        if (!row) {
          scheduleGenerationScope(this.db, policy.owner, policy.project, now + 2000);
          return null;
        }
        const token = randomUUID(),
          failures = row.failures + (row.state === "claimed" ? 1 : 0);
        this.db
          .query(
            "UPDATE knowledge_generation_jobs SET state=?,token=?,leaseUntil=?,failures=?,updatedAt=? WHERE owner=? AND project=? AND documentId=?",
          )
          .run(
            failures >= 3 ? "failed" : "claimed",
            failures >= 3 ? null : token,
            failures >= 3 ? null : now + 30000,
            failures,
            now,
            row.owner,
            row.project,
            row.documentId,
          );
        scheduleGenerationScope(this.db, policy.owner, policy.project, now + 2000);
        return failures >= 3
          ? null
          : {
              owner: row.owner,
              project: row.project,
              source: { id: row.documentId, kind: row.sourceKind, version: row.version },
              policyRevision: row.policyRevision,
              operationId: row.operationId,
              token,
              purpose: policy.purpose,
            };
      })
      .immediate();
  }
  heartbeat(lease: GenerationLease, now: number) {
    if (!generationLeaseCurrent(this.db, lease, now)) throw new KnowledgeTaskError("leaseLost");
    this.db
      .query(
        "UPDATE knowledge_generation_jobs SET leaseUntil=? WHERE owner=? AND project=? AND documentId=? AND token=?",
      )
      .run(now + 30000, lease.owner, lease.project, lease.source.id, lease.token);
  }
  release(lease: GenerationLease, now: number, retryAt: number, failed = false, pauseScope = false) {
    return this.db
      .transaction(() => {
        if (!generationLeaseCurrent(this.db, lease, now)) return;
        this.db
          .query(
            `UPDATE knowledge_generation_jobs SET state=CASE WHEN failures+?>=3 THEN 'failed' ELSE 'queued' END,
        failures=failures+?,token=NULL,leaseUntil=NULL,notBefore=?,updatedAt=? WHERE owner=? AND project=? AND documentId=? AND token=?`,
          )
          .run(failed ? 1 : 0, failed ? 1 : 0, retryAt, now, lease.owner, lease.project, lease.source.id, lease.token);
        scheduleGenerationScope(this.db, lease.owner, lease.project, pauseScope ? retryAt : now + 2000);
      })
      .immediate();
  }
}
