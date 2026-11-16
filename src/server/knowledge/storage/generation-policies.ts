import type { Database } from "bun:sqlite";
import {
  defaultGenerationPolicy,
  generationChange,
  type KnowledgeGenerationChange,
} from "../../../shared/knowledge/generation.js";
import type {
  GenerationSnapshot,
  StoredGenerationPolicy,
  KnowledgeGenerationPolicyStore,
} from "../generation/contracts.js";
import { KnowledgeTaskError, type KnowledgeTaskStore } from "../tasks/contracts.js";
import { cancelGeneratedTasks, generationSnapshotSources } from "./generation-common.js";
import { randomUUID } from "node:crypto";

interface StoredPolicy {
  owner: string;
  project: string;
  enabled: number;
  revision: number;
  purpose: string;
  selection: string;
  dailyLimit: number;
  pendingLimit: number;
  observedCommit: string | null;
}
function decode(row: StoredPolicy): StoredGenerationPolicy {
  const policy = generationChange({
    enabled: row.enabled === 1,
    revision: row.revision,
    purpose: row.purpose,
    selection: JSON.parse(row.selection),
    dailyLimit: row.dailyLimit,
    pendingLimit: row.pendingLimit,
    backfill: false,
  });
  const { backfill: _backfill, ...value } = policy;
  return { ...value, owner: row.owner, project: row.project, observedCommit: row.observedCommit };
}
export class KnowledgeGenerationPolicies implements KnowledgeGenerationPolicyStore {
  constructor(
    private db: Database,
    private tasks: Pick<KnowledgeTaskStore, "cancel">,
  ) {}
  policy(owner: string, project: string): StoredGenerationPolicy {
    const row = this.db
      .query<StoredPolicy, [string, string]>("SELECT * FROM knowledge_generation_policies WHERE owner=? AND project=?")
      .get(owner, project);
    return row ? decode(row) : { ...defaultGenerationPolicy(), owner, project, observedCommit: null };
  }
  next(now: number, after?: { owner: string; project: string }): StoredGenerationPolicy | null {
    const row = this.db
      .query<StoredPolicy, [number, string, string, string]>(
        `SELECT * FROM knowledge_generation_policies
      WHERE enabled=1 AND nextScanAt<=? AND (owner>? OR (owner=? AND project>?)) ORDER BY owner,project LIMIT 1`,
      )
      .get(now, after?.owner ?? "", after?.owner ?? "", after?.project ?? "");
    return row ? decode(row) : null;
  }
  configure(
    owner: string,
    project: string,
    value: KnowledgeGenerationChange,
    snapshot: GenerationSnapshot | null,
    now: number,
  ) {
    if (value.enabled && !snapshot) throw new KnowledgeTaskError("conflict");
    const matched = snapshot ? generationSnapshotSources(snapshot) : [];
    return this.db
      .transaction(() => {
        if (this.policy(owner, project).revision !== value.revision) throw new KnowledgeTaskError("conflict");
        const cancelled = cancelGeneratedTasks(this.db, this.tasks, owner, project, now),
          revision = value.revision + 1;
        this.db
          .query(
            `INSERT INTO knowledge_generation_policies(owner,project,revision,enabled,purpose,selection,dailyLimit,pendingLimit,observedCommit,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,project)
        DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,purpose=excluded.purpose,selection=excluded.selection,
        dailyLimit=excluded.dailyLimit,pendingLimit=excluded.pendingLimit,observedCommit=excluded.observedCommit,updatedAt=excluded.updatedAt,nextScanAt=0,scanFailures=0`,
          )
          .run(
            owner,
            project,
            revision,
            value.enabled ? 1 : 0,
            value.purpose,
            JSON.stringify(value.selection),
            value.dailyLimit,
            value.pendingLimit,
            snapshot?.commit ?? null,
            now,
          );
        this.db.query("DELETE FROM knowledge_generation_jobs WHERE owner=? AND project=?").run(owner, project);
        const insert = this.db.query(
          `INSERT INTO knowledge_generation_jobs(owner,project,documentId,version,policyRevision,operationId,state,token,leaseUntil,notBefore,failures,taskId,updatedAt,sourceKind) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,0,NULL,?,?)`,
        );
        if (value.enabled)
          for (const doc of matched)
            insert.run(
              owner,
              project,
              doc.id,
              doc.version,
              revision,
              randomUUID(),
              value.backfill ? "queued" : "observed",
              now + 1500,
              now,
              doc.kind,
            );
        this.db
          .query("UPDATE knowledge_generation_policies SET nextAdmissionAt=? WHERE owner=? AND project=?")
          .run(value.enabled && value.backfill && matched.length ? now + 1500 : null, owner, project);
        return { policy: this.policy(owner, project), cancelled };
      })
      .immediate();
  }
  checked(policy: StoredGenerationPolicy, now: number, failed: boolean) {
    const until = now + (failed ? Math.min(300000, 5000 * 2 ** this.failures(policy)) : 5000);
    this.db
      .query(
        `UPDATE knowledge_generation_policies SET nextScanAt=?,scanFailures=CASE WHEN ?=1 THEN MIN(scanFailures+1,8) ELSE 0 END
      ,nextAdmissionAt=CASE WHEN ?=1 AND nextAdmissionAt IS NOT NULL THEN MAX(nextAdmissionAt,?) ELSE nextAdmissionAt END
      WHERE owner=? AND project=? AND revision=? AND observedCommit IS ?`,
      )
      .run(
        until,
        failed ? 1 : 0,
        failed ? 1 : 0,
        until,
        policy.owner,
        policy.project,
        policy.revision,
        policy.observedCommit,
      );
  }
  private failures(policy: StoredGenerationPolicy) {
    return (
      this.db
        .query<{ scanFailures: number }, [string, string]>(
          "SELECT scanFailures FROM knowledge_generation_policies WHERE owner=? AND project=?",
        )
        .get(policy.owner, policy.project)?.scanFailures ?? 0
    );
  }
}
