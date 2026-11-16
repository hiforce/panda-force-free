import type { Database } from "bun:sqlite";
import type { SkillRegistryCommand, SkillMutation } from "../ports.js";
import type { InstalledSkillPack, SkillRegistryAudit } from "../../../shared/skills/registry.js";
import { SkillRegistryError } from "../errors.js";
import type { SkillRegistryReads } from "./reads.js";
import type { SkillMutationJournal } from "./journal.js";
export class SkillRegistryWrites {
  constructor(
    private db: Database,
    private reads: SkillRegistryReads,
    private journal: SkillMutationJournal,
  ) {}
  apply(command: SkillRegistryCommand, mutation: SkillMutation): InstalledSkillPack {
    return this.journal.apply(mutation, () => {
      const id = command.kind === "install" ? command.pack.id : command.id,
        version = command.kind === "install" ? command.pack.version : command.version;
      let prior = this.reads.get(id, version),
        action: SkillRegistryAudit["action"] = command.kind,
        details: unknown = {};
      if (command.kind === "install") {
        const value = command.pack;
        if (prior && prior.digest !== value.digest) throw new SkillRegistryError("immutableVersion");
        if (!prior) {
          const sizes = this.db
            .query<{ count: number; bytes: number }, []>(
              "SELECT count(*) AS count,COALESCE(sum(length(CAST(manifest AS BLOB))),0) AS bytes FROM skill_versions",
            )
            .get()!;
          if (sizes.count >= 1024 || sizes.bytes + Buffer.byteLength(JSON.stringify(value.manifest)) > 64 * 1024 * 1024)
            throw new SkillRegistryError("unavailable");
          this.db
            .query("INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?,?,0)")
            .run(
              id,
              version,
              value.digest,
              JSON.stringify(value.manifest),
              JSON.stringify(value.origin),
              JSON.stringify(value.grants),
              mutation.now,
              mutation.actor,
            );
        } else
          this.db
            .query("UPDATE skill_versions SET origin=?,grants=?,removed=0 WHERE id=? AND version=?")
            .run(JSON.stringify(value.origin), JSON.stringify(value.grants), id, version);
        this.replaceExports(id, version, value.exports);
        this.db
          .query("INSERT INTO skill_heads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version")
          .run(id, version);
        details = { exports: value.exports, grants: value.grants, origin: value.origin };
      } else {
        if (!prior || prior.removed) throw new SkillRegistryError("notInstalled");
        if (command.kind === "activate") {
          if (!prior.exports.some((value) => value.enabled)) throw new SkillRegistryError("skillDisabled");
          this.db
            .query("INSERT INTO skill_heads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version")
            .run(id, version);
        } else if (command.kind === "exports") {
          const expected = prior.manifest.skills.map((skill) => skill.id).sort(),
            received = command.exports.map((item) => item.id).sort();
          if (expected.length !== received.length || expected.some((value, index) => value !== received[index]))
            throw new SkillRegistryError("invalidInput");
          this.replaceExports(id, version, command.exports);
          details = { exports: command.exports };
        } else {
          this.db.query("UPDATE skill_versions SET removed=1 WHERE id=? AND version=?").run(id, version);
          this.db.query("UPDATE skill_exports SET enabled=0 WHERE packageId=? AND version=?").run(id, version);
          this.db.query("DELETE FROM skill_heads WHERE id=? AND version=?").run(id, version);
        }
      }
      const value = this.reads.get(id, version);
      if (!value) throw new SkillRegistryError("unavailable");
      return { action, value, details };
    });
  }
  private replaceExports(id: string, version: string, exports: readonly { id: string; enabled: boolean }[]): void {
    this.db.query("DELETE FROM skill_exports WHERE packageId=? AND version=?").run(id, version);
    for (const value of exports)
      this.db.query("INSERT INTO skill_exports VALUES(?,?,?,?)").run(id, version, value.id, value.enabled ? 1 : 0);
  }
}
