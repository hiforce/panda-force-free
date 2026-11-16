import type { MySQLMetadataContext } from "./mysql-context.js";
import type { AsyncMetadataStore } from "../metadata-ports.js";
import {
  defaultGenerationPolicy,
  generationChange,
  type KnowledgeGenerationChange,
} from "../../../shared/knowledge/generation.js";
import type { GenerationSnapshot, StoredGenerationPolicy } from "../generation/contracts.js";
import { KnowledgeTaskError, type KnowledgeTaskStore } from "../tasks/contracts.js";
import { mysqlCancelGeneratedTasks, generationSnapshotSources } from "./mysql-generation-common.js";
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
export class MySQLKnowledgeGenerationPolicies {
  constructor(
    private db: MySQLMetadataContext,
    private tasks: Pick<AsyncMetadataStore<KnowledgeTaskStore>, "cancel">,
  ) {}
  async policy(owner: string, project: string): Promise<StoredGenerationPolicy> {
    return await this.db.atomic(async () => {
      const row = await this.db.one<StoredPolicy>(
        "SELECT * FROM panda_force_knowledge_generation_policies WHERE owner=? AND project=?",
        [owner, project],
      );
      return row ? decode(row) : { ...defaultGenerationPolicy(), owner, project, observedCommit: null };
    });
  }
  async next(
    now: number,
    after?: {
      owner: string;
      project: string;
    },
  ): Promise<StoredGenerationPolicy | null> {
    return await this.db.atomic(async () => {
      const row = await this.db.one<StoredPolicy>(
        `SELECT * FROM panda_force_knowledge_generation_policies
      WHERE enabled=1 AND nextScanAt<=? AND (owner>? OR (owner=? AND project>?)) ORDER BY owner,project LIMIT 1`,
        [now, after?.owner ?? "", after?.owner ?? "", after?.project ?? ""],
      );
      return row ? decode(row) : null;
    });
  }
  async configure(
    owner: string,
    project: string,
    value: KnowledgeGenerationChange,
    snapshot: GenerationSnapshot | null,
    now: number,
  ) {
    return await this.db.atomic(async () => {
      if (value.enabled && !snapshot) throw new KnowledgeTaskError("conflict");
      const matched = snapshot ? generationSnapshotSources(snapshot) : [];
      return await this.db.atomic(async () => {
        if ((await this.policy(owner, project)).revision !== value.revision) throw new KnowledgeTaskError("conflict");
        const cancelled = await mysqlCancelGeneratedTasks(this.db, this.tasks, owner, project, now),
          revision = value.revision + 1;
        await this.db.execute(
          `INSERT INTO panda_force_knowledge_generation_policies(owner,project,revision,enabled,purpose,selection,dailyLimit,pendingLimit,observedCommit,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),enabled=VALUES(enabled),purpose=VALUES(purpose),selection=VALUES(selection),
        dailyLimit=VALUES(dailyLimit),pendingLimit=VALUES(pendingLimit),observedCommit=VALUES(observedCommit),updatedAt=VALUES(updatedAt),nextScanAt=0,scanFailures=0`,
          [
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
          ],
        );
        await this.db.execute("DELETE FROM panda_force_knowledge_generation_jobs WHERE owner=? AND project=?", [
          owner,
          project,
        ]);
        const insert = `INSERT INTO panda_force_knowledge_generation_jobs(owner,project,documentId,version,policyRevision,operationId,state,token,leaseUntil,notBefore,failures,taskId,updatedAt,sourceKind) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,0,NULL,?,?)`;
        if (value.enabled)
          for (const doc of matched)
            await this.db.execute(insert, [
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
            ]);
        await this.db.execute(
          "UPDATE panda_force_knowledge_generation_policies SET nextAdmissionAt=? WHERE owner=? AND project=?",
          [value.enabled && value.backfill && matched.length ? now + 1500 : null, owner, project],
        );
        return { policy: await this.policy(owner, project), cancelled };
      });
    });
  }
  async checked(policy: StoredGenerationPolicy, now: number, failed: boolean) {
    return await this.db.atomic(async () => {
      const until = now + (failed ? Math.min(300000, 5000 * 2 ** (await this.failures(policy))) : 5000);
      await this.db.execute(
        `UPDATE panda_force_knowledge_generation_policies SET nextScanAt=?,scanFailures=CASE WHEN ?=1 THEN LEAST(scanFailures+1,8) ELSE 0 END
      ,nextAdmissionAt=CASE WHEN ?=1 AND nextAdmissionAt IS NOT NULL THEN GREATEST(nextAdmissionAt,?) ELSE nextAdmissionAt END
      WHERE owner=? AND project=? AND revision=? AND observedCommit <=> ?`,
        [
          until,
          failed ? 1 : 0,
          failed ? 1 : 0,
          until,
          policy.owner,
          policy.project,
          policy.revision,
          policy.observedCommit,
        ],
      );
    });
  }
  private async failures(policy: StoredGenerationPolicy) {
    return await this.db.atomic(async () => {
      return (
        (
          await this.db.one<{
            scanFailures: number;
          }>("SELECT scanFailures FROM panda_force_knowledge_generation_policies WHERE owner=? AND project=?", [
            policy.owner,
            policy.project,
          ])
        )?.scanFailures ?? 0
      );
    });
  }
}
