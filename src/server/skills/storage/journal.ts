import type { Database } from "bun:sqlite";
import type { InstalledSkillPack, SkillRegistryAudit } from "../../../shared/skills/registry.js";
import type { SkillMutation } from "../ports.js";
import { SkillRegistryError } from "../errors.js";
import type { SkillRegistryReads } from "./reads.js";
export class SkillMutationJournal {
  constructor(
    private db: Database,
    private reads: SkillRegistryReads,
  ) {}
  replay(actor: string, id: string, request: string): InstalledSkillPack | null {
    const row = this.db
      .query<{ actor: string; request: string; packageId: string; version: string }, [string]>(
        "SELECT actor,request,packageId,version FROM skill_operations WHERE id=?",
      )
      .get(id);
    if (!row) return null;
    if (row.actor !== actor) throw new SkillRegistryError("notFound");
    if (row.request !== request) throw new SkillRegistryError("operationConflict");
    const value = this.reads.get(row.packageId, row.version);
    if (!value) throw new SkillRegistryError("unavailable");
    return value;
  }
  apply(
    mutation: SkillMutation,
    operation: () => { action: SkillRegistryAudit["action"]; value: InstalledSkillPack; details: unknown },
  ): InstalledSkillPack {
    return this.db
      .transaction(() => {
        const prior = this.replay(mutation.actor, mutation.id, mutation.request);
        if (prior) return prior;
        if (this.reads.revision() !== mutation.expectedRevision) throw new SkillRegistryError("registryConflict");
        if (
          this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM skill_operations").get()!.count >= 100000
        )
          throw new SkillRegistryError("unavailable");
        const result = operation();
        this.db.query("UPDATE skill_registry SET revision=revision+1 WHERE id=1").run();
        const revision = this.reads.revision(),
          value = result.value;
        this.db
          .query("INSERT INTO skill_operations VALUES(?,?,?,?,?,?)")
          .run(mutation.id, mutation.actor, mutation.request, value.id, value.version, revision);
        this.db
          .query(
            "INSERT INTO skill_audit(revision,action,id,version,digest,actor,operationId,createdAt,details) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            revision,
            result.action,
            value.id,
            value.version,
            value.digest,
            mutation.actor,
            mutation.id,
            mutation.now,
            JSON.stringify(result.details),
          );
        return this.reads.get(value.id, value.version)!;
      })
      .immediate();
  }
}
