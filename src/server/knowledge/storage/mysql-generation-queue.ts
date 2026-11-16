import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import type { SavedSourceKind } from "../../../shared/content-sources/contracts.js";
import { randomUUID } from "node:crypto";
import type { GenerationLease, GenerationSnapshot, StoredGenerationPolicy } from "../generation/contracts.js";
import type { KnowledgeTaskStore } from "../tasks/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import {
  mysqlCancelGeneratedTasks,
  mysqlGenerationLeaseCurrent,
  mysqlScheduleGenerationScope,
  generationSnapshotSources,
} from "./mysql-generation-common.js";
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
export class MySQLKnowledgeGenerationQueue {
  constructor(
    private db: MySQLMetadataContext,
    private tasks: Pick<AsyncMetadataStore<KnowledgeTaskStore>, "cancel">,
  ) {}
  async reconcile(policy: StoredGenerationPolicy, snapshot: GenerationSnapshot, now: number) {
    return await this.db.atomic(async () => {
      const matched = generationSnapshotSources(snapshot);
      return await this.db.atomic(async () => {
        if (
          !(await this.db.one(
            "SELECT 1 FROM panda_force_knowledge_generation_policies WHERE owner=? AND project=? AND enabled=1 AND revision=? AND observedCommit <=> ?",
            [policy.owner, policy.project, policy.revision, policy.observedCommit],
          ))
        )
          throw new KnowledgeTaskError("conflict");
        const prior = new Map(
            (
              await this.db.all<Job>(
                "SELECT documentId,version,state,failures,sourceKind FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=?",
                [policy.owner, policy.project],
              )
            ).map((row) => [row.documentId, row]),
          ),
          cancelled: string[] = [];
        for (const doc of matched) {
          const old = prior.get(doc.id);
          prior.delete(doc.id);
          if (old && old.sourceKind === doc.kind && old.version === doc.version && old.state !== "excluded") continue;
          cancelled.push(
            ...(await mysqlCancelGeneratedTasks(this.db, this.tasks, policy.owner, policy.project, now, {
              id: doc.id,
              kind: old?.sourceKind ?? doc.kind,
            })),
          );
          await this.db.execute(
            `INSERT INTO panda_force_knowledge_generation_jobs(owner,project,documentId,version,policyRevision,operationId,state,token,leaseUntil,notBefore,failures,taskId,updatedAt,sourceKind) VALUES(?,?,?,?,?,?,'queued',NULL,NULL,?,0,NULL,?,?)
          ON DUPLICATE KEY UPDATE version=VALUES(version),sourceKind=VALUES(sourceKind),policyRevision=VALUES(policyRevision),
          operationId=VALUES(operationId),state='queued',token=NULL,leaseUntil=NULL,notBefore=VALUES(notBefore),
          failures=0,taskId=NULL,updatedAt=VALUES(updatedAt)`,
            [
              policy.owner,
              policy.project,
              doc.id,
              doc.version,
              policy.revision,
              randomUUID(),
              now + 1500,
              now,
              doc.kind,
            ],
          );
        }
        for (const doc of prior.values()) {
          if (doc.state === "excluded") continue;
          cancelled.push(
            ...(await mysqlCancelGeneratedTasks(this.db, this.tasks, policy.owner, policy.project, now, {
              id: doc.documentId,
              kind: doc.sourceKind,
            })),
          );
          await this.db.execute(
            "DELETE FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=? AND documentId=?",
            [policy.owner, policy.project, doc.documentId],
          );
        }
        await this.db.execute(
          "UPDATE panda_force_knowledge_generation_policies SET observedCommit=? WHERE owner=? AND project=? AND revision=?",
          [snapshot.commit, policy.owner, policy.project, policy.revision],
        );
        await mysqlScheduleGenerationScope(this.db, policy.owner, policy.project, now);
        return cancelled;
      });
    });
  }
  async claim(now: number): Promise<GenerationLease | null> {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const policy = await this.db.one<{
          owner: string;
          project: string;
          revision: number;
          purpose: string;
        }>(
          `SELECT owner,project,revision,purpose FROM panda_force_knowledge_generation_policies
         WHERE enabled=1 AND scanFailures=0 AND nextAdmissionAt<=? ORDER BY nextAdmissionAt,owner,project LIMIT 1`,
          [now],
        );
        if (!policy) return null;
        const expired = await this.db.one<Candidate>(
            `SELECT * FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=? AND policyRevision=?
         AND state='claimed' AND leaseUntil<=? AND failures<3 ORDER BY leaseUntil,updatedAt,documentId LIMIT 1`,
            [policy.owner, policy.project, policy.revision, now],
          ),
          row =
            expired ??
            (await this.db.one<Candidate>(
              `SELECT * FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=? AND policyRevision=?
           AND state='queued' AND notBefore<=? AND failures<3 ORDER BY notBefore,updatedAt,documentId LIMIT 1`,
              [policy.owner, policy.project, policy.revision, now],
            ));
        if (!row) {
          await mysqlScheduleGenerationScope(this.db, policy.owner, policy.project, now + 2000);
          return null;
        }
        const token = randomUUID(),
          failures = row.failures + (row.state === "claimed" ? 1 : 0);
        await this.db.execute(
          "UPDATE panda_force_knowledge_generation_jobs SET state=?,token=?,leaseUntil=?,failures=?,updatedAt=? WHERE owner=? AND project=? AND documentId=?",
          [
            failures >= 3 ? "failed" : "claimed",
            failures >= 3 ? null : token,
            failures >= 3 ? null : now + 30000,
            failures,
            now,
            row.owner,
            row.project,
            row.documentId,
          ],
        );
        await mysqlScheduleGenerationScope(this.db, policy.owner, policy.project, now + 2000);
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
      });
    });
  }
  async heartbeat(lease: GenerationLease, now: number) {
    return await this.db.atomic(async () => {
      if (!(await mysqlGenerationLeaseCurrent(this.db, lease, now))) throw new KnowledgeTaskError("leaseLost");
      await this.db.execute(
        "UPDATE panda_force_knowledge_generation_jobs SET leaseUntil=? WHERE owner=? AND project=? AND documentId=? AND token=?",
        [now + 30000, lease.owner, lease.project, lease.source.id, lease.token],
      );
    });
  }
  async release(lease: GenerationLease, now: number, retryAt: number, failed = false, pauseScope = false) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        if (!(await mysqlGenerationLeaseCurrent(this.db, lease, now))) return;
        await this.db.execute(
          `UPDATE panda_force_knowledge_generation_jobs SET state=CASE WHEN failures+?>=3 THEN 'failed' ELSE 'queued' END,
        failures=failures+?,token=NULL,leaseUntil=NULL,notBefore=?,updatedAt=? WHERE owner=? AND project=? AND documentId=? AND token=?`,
          [failed ? 1 : 0, failed ? 1 : 0, retryAt, now, lease.owner, lease.project, lease.source.id, lease.token],
        );
        await mysqlScheduleGenerationScope(this.db, lease.owner, lease.project, pauseScope ? retryAt : now + 2000);
      });
    });
  }
}
