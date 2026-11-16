import type { Database } from "bun:sqlite";
import type { InstalledSkillPack, SkillRegistryPage, SkillRegistryAudit } from "../../../shared/skills/registry.js";
import { SkillRegistryError } from "../errors.js";
import { installedSkillRecord, type SkillRegistryRow as Row } from "./records.js";
const select =
  "SELECT v.*,CASE WHEN h.version=v.version THEN 1 ELSE 0 END AS active FROM skill_versions v LEFT JOIN skill_heads h ON h.id=v.id";
export class SkillRegistryReads {
  constructor(private db: Database) {}
  revision(): number {
    return this.db.query<{ revision: number }, []>("SELECT revision FROM skill_registry WHERE id=1").get()!.revision;
  }
  private record(row: Row): InstalledSkillPack {
    const exports = this.db
      .query<{ id: string; enabled: number }, [string, string]>(
        "SELECT id,enabled FROM skill_exports WHERE packageId=? AND version=? ORDER BY id",
      )
      .all(row.id, row.version)
      .map((v) => ({ id: v.id, enabled: !!v.enabled }));
    return installedSkillRecord(row, exports);
  }
  get(id: string, version: string): InstalledSkillPack | null {
    const row = this.db.query<Row, [string, string]>(select + " WHERE v.id=? AND v.version=?").get(id, version);
    return row ? this.record(row) : null;
  }
  detail(id: string, version: string) {
    return this.db.transaction(() => ({ revision: this.revision(), package: this.get(id, version) }))();
  }
  active(id: string): InstalledSkillPack | null {
    const row = this.db.query<Row, [string]>(select + " WHERE v.id=? AND h.version=v.version AND v.removed=0").get(id);
    return row ? this.record(row) : null;
  }
  known(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM skill_versions WHERE id=? LIMIT 1").get(id);
  }
  list(cursor?: string, limit = 50, activeOnly = false): SkillRegistryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SkillRegistryError("invalidInput");
    let id = "",
      version = "";
    if (cursor !== undefined) {
      try {
        if (cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const tuple: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(tuple) || tuple.length !== 2 || tuple.some((value) => typeof value !== "string"))
          throw new Error();
        [id, version] = tuple as [string, string];
      } catch {
        throw new SkillRegistryError("invalidInput");
      }
    }
    return this.db.transaction(() => {
      const rows = this.db
          .query<Row, [string, string, string, number]>(
            select +
              (activeOnly
                ? " WHERE h.version=v.version AND v.removed=0 AND EXISTS(SELECT 1 FROM skill_exports e WHERE e.packageId=v.id AND e.version=v.version AND e.enabled=1) AND"
                : " WHERE") +
              " (v.id>? OR (v.id=? AND v.version>?)) ORDER BY v.id,v.version LIMIT ?",
          )
          .all(id, id, version, limit + 1),
        visible = rows.slice(0, limit),
        last = visible.at(-1);
      return {
        revision: this.revision(),
        packages: visible.map((row) => this.record(row)),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(JSON.stringify([last.id, last.version])).toString("base64url")
            : null,
      };
    })();
  }
  audit(after?: number, limit = 100): SkillRegistryAudit[] {
    if (
      (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new SkillRegistryError("invalidInput");
    const rows = this.db
      .query<Omit<SkillRegistryAudit, "details"> & { details: string }, [number, number]>(
        "SELECT * FROM skill_audit WHERE sequence>? ORDER BY sequence " +
          (after === undefined ? "DESC" : "ASC") +
          " LIMIT ?",
      )
      .all(after ?? 0, limit)
      .map((row) => ({ ...row, details: JSON.parse(row.details) }));
    return after === undefined ? rows.reverse() : rows;
  }
}
