import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { normalizeProjectVisibilityKey } from "../../shared/project-visibility.js";
import type { ProjectVisibilityRepository } from "../contracts/runtime.js";
import { projectVisibilityState } from "./visibility-records.js";
import { mysqlInteger } from "../database/mysql-model.js";
import { ProjectError } from "../projects/catalog.js";
import { consistentMySQLRead } from "../database/consistent-read.js";
export const visibilityPathHash = (path: string) => createHash("sha256").update(path).digest("hex");
/** Preferences never cache authority or engine history. A global row serializes hide/restore revisions across replicas. */
export class MySQLProjectVisibilityStore implements ProjectVisibilityRepository {
  constructor(
    private readonly pool: SQL,
    private readonly home: string,
  ) {}
  async snapshot() {
    try {
      return await consistentMySQLRead(this.pool, async (tx) => {
        const meta = (await tx`SELECT revision FROM panda_force_visibility_meta WHERE id=1`)[0],
          rows = await tx`SELECT pathHash,path,hiddenAt FROM panda_force_hidden_projects`;
        for (const r of rows) if (r.pathHash !== visibilityPathHash(r.path)) throw Error("Invalid hidden project");
        return projectVisibilityState({
          revision: meta ? mysqlInteger(meta.revision) : 0,
          hiddenProjects: Object.fromEntries(
            rows.map((r: { path: string; hiddenAt: unknown }) => [r.path, { hiddenAt: mysqlInteger(r.hiddenAt) }]),
          ),
        });
      });
    } catch (error) {
      const failure = new ProjectError(503, "errors.couldNotLoadProjects");
      failure.cause = error;
      throw failure;
    }
  }
  async setHidden(path: unknown, hidden: boolean, expectedHiddenAt?: unknown) {
    const key = normalizeProjectVisibilityKey(path, this.home);
    if (!key || typeof hidden !== "boolean") throw Error("Invalid project visibility request");
    if (expectedHiddenAt !== undefined && (!Number.isSafeInteger(expectedHiddenAt) || Number(expectedHiddenAt) <= 0))
      throw Error("Invalid hidden project version");
    try {
      return await this.pool.begin(async (tx) => {
        await tx`INSERT INTO panda_force_visibility_meta(id,revision) VALUES(1,0) ON DUPLICATE KEY UPDATE id=VALUES(id)`;
        const hash = visibilityPathHash(key),
          current = (await tx`SELECT path,hiddenAt FROM panda_force_hidden_projects WHERE pathHash=${hash}`)[0];
        if (current && current.path !== key) throw Error("Invalid hidden project");
        if (expectedHiddenAt !== undefined && (!current || mysqlInteger(current.hiddenAt) !== expectedHiddenAt))
          return false;
        if (!!current === hidden) return false;
        const prior = mysqlInteger((await tx`SELECT revision FROM panda_force_visibility_meta WHERE id=1`)[0].revision),
          revision = Math.max(Date.now(), prior + 1);
        if (!Number.isSafeInteger(revision)) throw Error("Invalid project visibility store");
        if (hidden)
          await tx`INSERT INTO panda_force_hidden_projects(pathHash,path,hiddenAt) VALUES(${hash},${key},${revision})`;
        else await tx`DELETE FROM panda_force_hidden_projects WHERE pathHash=${hash}`;
        await tx`UPDATE panda_force_visibility_meta SET revision=${revision} WHERE id=1`;
        return true;
      });
    } catch (error) {
      const failure = new ProjectError(503, "errors.couldNotUpdateProject");
      failure.cause = error;
      throw failure;
    }
  }
}
