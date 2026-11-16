import type { SQL } from "bun";
import { createHash } from "node:crypto";
import {
  defaultSkillWorkspace,
  SkillWorkspaceError,
  type SkillWorkspaceSnapshot,
} from "../../shared/skill-workspace.js";
import { storedWorkspace } from "./snapshot.js";
import { mysqlInteger } from "../database/mysql-model.js";
import type { SkillWorkspaceRepository } from "./ports.js";

export class MySQLSkillWorkspaceStore implements SkillWorkspaceRepository {
  constructor(private sql: SQL) {}
  private async protect<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SkillWorkspaceError) throw error;
      const failure = new SkillWorkspaceError("unavailable");
      failure.cause = error;
      throw failure;
    }
  }
  private async readOn(sql: SQL, owner: string) {
    const row = (await sql`SELECT revision,data FROM panda_force_skill_workspaces WHERE owner=${owner}`)[0];
    if (!row) return defaultSkillWorkspace();
    const result = storedWorkspace(row.data);
    if (result.revision !== mysqlInteger(row.revision)) throw new SkillWorkspaceError("unavailable");
    return result;
  }
  read(owner: string) {
    return this.protect(() => this.readOn(this.sql, owner));
  }
  private async replayOn(sql: SQL, owner: string, id: string, request: string) {
    const row = (
      await sql`SELECT request,receipt FROM panda_force_skill_workspace_operations WHERE owner=${owner} AND id=${id}`
    )[0];
    if (!row) return null;
    if (row.request !== request) throw new SkillWorkspaceError("conflict");
    return storedWorkspace(row.receipt);
  }
  replay(owner: string, id: string, request: string) {
    return this.protect(() => this.replayOn(this.sql, owner, id, request));
  }
  save(owner: string, id: string, request: string, expected: number, next: SkillWorkspaceSnapshot) {
    const snapshot = structuredClone(next);
    return this.protect(() =>
      this.sql.begin(async (sql) => {
        const lock = createHash("sha256").update(owner).digest("hex");
        await sql`INSERT INTO panda_force_skill_workspace_controls(id) VALUES(${lock}) ON DUPLICATE KEY UPDATE id=VALUES(id)`;
        const replay = await this.replayOn(sql, owner, id, request);
        if (replay) return replay;
        if ((await this.readOn(sql, owner)).revision !== expected) throw new SkillWorkspaceError("conflict");
        const result = { ...snapshot, revision: expected + 1 },
          data = JSON.stringify(result);
        await sql`INSERT INTO panda_force_skill_workspaces(owner,revision,data) VALUES(${owner},${result.revision},${data}) ON DUPLICATE KEY UPDATE revision=VALUES(revision),data=VALUES(data)`;
        await sql`INSERT INTO panda_force_skill_workspace_operations(owner,id,request,receipt,createdAt) VALUES(${owner},${id},${request},${data},${Date.now()})`;
        await sql`DELETE old FROM panda_force_skill_workspace_operations old LEFT JOIN (SELECT seq FROM panda_force_skill_workspace_operations WHERE owner=${owner} ORDER BY seq DESC LIMIT 200) recent ON recent.seq=old.seq WHERE old.owner=${owner} AND recent.seq IS NULL`;
        return result;
      }),
    );
  }
  close() {}
}
