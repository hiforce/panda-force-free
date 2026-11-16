import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { SkillCapture } from "../../../shared/skills/registry.js";
import { freezeSkillValue } from "../../../shared/skills/resources.js";
import { SkillRegistryError } from "../errors.js";
import type { SkillRegistryReads } from "./reads.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class SkillCaptures {
  constructor(
    private db: Database,
    private reads: SkillRegistryReads,
  ) {}
  get(owner: string, id: string, request?: string): SkillCapture | null {
    const row = this.db
      .query<{ owner: string; request: string; payload: string; digest: string }, [string]>(
        "SELECT owner,request,payload,digest FROM skill_captures WHERE id=?",
      )
      .get(id);
    if (!row) return null;
    if (row.owner !== owner) throw new SkillRegistryError("notFound");
    if (request !== undefined && row.request !== request) throw new SkillRegistryError("operationConflict");
    if (hash(row.payload) !== row.digest) throw new SkillRegistryError("unavailable");
    try {
      const value = JSON.parse(row.payload) as SkillCapture;
      if (value.id !== id || value.owner !== owner || value.composition.schema !== 1) throw new Error();
      return freezeSkillValue(value);
    } catch {
      throw new SkillRegistryError("unavailable");
    }
  }
  put(value: SkillCapture, request: string, expectedRevision: number): SkillCapture {
    return this.db
      .transaction(() => {
        const prior = this.get(value.owner, value.id, request);
        if (prior) return prior;
        if (this.reads.revision() !== expectedRevision) throw new SkillRegistryError("registryConflict");
        const payload = JSON.stringify(value),
          bytes = Buffer.byteLength(payload),
          capacity = this.db
            .query<{ count: number; bytes: number }, []>(
              "SELECT count(*) AS count,COALESCE(sum(byteLength),0) AS bytes FROM skill_captures",
            )
            .get()!;
        if (bytes > 1024 * 1024 || capacity.count >= 10000 || capacity.bytes + bytes > 128 * 1024 * 1024)
          throw new SkillRegistryError("unavailable");
        this.db
          .query("INSERT INTO skill_captures VALUES(?,?,?,?,?,?,?)")
          .run(value.id, value.owner, request, payload, hash(payload), bytes, value.createdAt);
        return this.get(value.owner, value.id, request)!;
      })
      .immediate();
  }
}
