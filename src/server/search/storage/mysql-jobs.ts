import { MySQLSearchJobRecords } from "./mysql-job-records.js";

import { randomUUID } from "node:crypto";
import { SearchError, type SearchScope } from "../../../shared/search/contracts.js";
import { searchSettings } from "../../../shared/search/validation.js";
import type { ActiveSearchIndex, SearchJobRow } from "../state.js";
import { retiredGeneration } from "../references.js";
import { searchScopeKey as scopeKey } from "../scope.js";

import { decodeSearchIndex } from "../descriptor.js";

import { mysqlResourceActivationAllowed } from "./mysql-resource-references.js";

export { searchScopeKey as scopeKey } from "../scope.js";
export class MySQLSearchJobs extends MySQLSearchJobRecords {
  async configure(scope: SearchScope, input: unknown, revision: number) {
    return await this.db.atomic(async () => {
      const settings = searchSettings(input);
      return await this.db.atomic(async () => {
        const old = await this.get(scope);
        if ((old?.revision ?? 0) !== revision) throw new SearchError("conflict", 409);
        if (!old && (await this.all()).length >= 256) throw new SearchError("limit", 409);
        const key = scopeKey(scope);
        if (scope.project !== "personal") await this.policies.configure(scope, settings, revision);
        await this.db.execute(
          `INSERT INTO panda_force_search_scopes(\`key\`,source,owner,project,settings,revision,requested,state,updatedAt) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE owner=VALUES(owner),settings=VALUES(settings),revision=VALUES(revision),requested=requested+1,state=VALUES(state),token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=VALUES(updatedAt)`,
          [
            key,
            scope.source,
            scope.owner,
            scope.project,
            JSON.stringify(settings),
            revision + 1,
            1,
            settings.enabled ? "queued" : "disabled",
            this.now(),
          ],
        );
        return (await this.byKey(key))!;
      });
    });
  }
  async wake(key: string, force = false) {
    return await this.db.atomic(async () => {
      await this.db.execute(
        "UPDATE panda_force_search_scopes SET requested=requested+1,state='queued',token=NULL,leaseUntil=NULL,attempts=0,failure=NULL,updatedAt=? WHERE `key`=? AND state!='disabled'" +
          (force ? " AND state!='needsReview'" : " AND state NOT IN ('queued','running','needsReview')"),
        [this.now(), key],
      );
    });
  }
  /** An explicit rebuild fences running work and prevents reuse of the physical generation being replaced. */
  async invalidate(key: string, expected?: Pick<SearchJobRow, "active" | "revision" | "requested">) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const row = await this.byKey(key);
        if (
          !row ||
          row.state === "disabled" ||
          (expected &&
            (row.active !== expected.active ||
              row.revision !== expected.revision ||
              row.requested !== expected.requested))
        )
          return false;
        const active = this.active(row);
        await this.db.execute("UPDATE panda_force_search_scopes SET active=? WHERE `key`=?", [
          active ? JSON.stringify({ ...active, invalidated: true }) : null,
          key,
        ]);
        await this.wake(key, true);
        return true;
      });
    });
  }
  /** Repeated administrator clicks join the pending full rebuild instead of fencing it again. */
  async rebuild(scope: SearchScope) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const row = await this.get(scope);
        if (!row) throw new SearchError("notFound", 404);
        if (!this.settings(row).enabled || row.state === "needsReview") throw new SearchError("notReady", 409);
        const active = this.active(row);
        if (["queued", "running"].includes(row.state) && (!active || active.invalidated)) return row;
        await this.invalidate(row.key, row);
        return (await this.byKey(row.key))!;
      });
    });
  }
  async signal(project: string, owner?: string) {
    return await this.db.atomic(async () => {
      for (const row of await this.all())
        if (
          row.project === project &&
          (project !== "personal" || !owner || row.owner === owner) &&
          row.state !== "disabled"
        )
          await this.wake(row.key);
    });
  }
  async claim(sources?: readonly string[]) {
    return await this.db.atomic(async () => {
      if (sources && !sources.length) return null;
      return await this.db.atomic(async () => {
        const candidate = (await this.all()).find(
          (row) =>
            (row.state === "queued" || (row.state === "running" && (row.leaseUntil ?? Infinity) < this.now())) &&
            (!sources || sources.includes(row.source)),
        );
        if (!candidate) return null;
        const row = await this.metadata.recover(candidate);
        if (row.state !== "queued" && row.state !== "running") return null;
        const token = randomUUID();
        await this.db.execute(
          "UPDATE panda_force_search_scopes SET state='running',token=?,leaseUntil=?,attempts=attempts+1 WHERE `key`=?",
          [token, this.now() + 120000, row.key],
        );
        const claimed = (await this.byKey(row.key))!;
        await this.progressStore.start(claimed);
        return claimed;
      });
    });
  }
  async heartbeat(row: SearchJobRow) {
    return this.db.atomic(async () => {
      const current = await this.db.one(
        "SELECT 1 FROM panda_force_search_scopes WHERE `key`=? AND token=? AND requested=? AND state='running' AND leaseUntil>?",
        [row.key, row.token, row.requested, this.now()],
      );
      if (!current) return false;
      await this.db.execute("UPDATE panda_force_search_scopes SET leaseUntil=? WHERE `key`=?", [
        this.now() + 120000,
        row.key,
      ]);
      return true;
    });
  }
  async complete(row: SearchJobRow, active: ActiveSearchIndex, commit: string, count: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const descriptor = JSON.stringify(active),
          decoded = decodeSearchIndex(descriptor, row.source);
        if (!decoded) throw new SearchError("configuration", 409);
        if (decoded.vector && !(await mysqlResourceActivationAllowed(this.db, decoded.vector))) return false;
        const previous = await this.byKey(row.key),
          valid = previous && (await this.policies.valid(previous)) && previous.settings === row.settings;
        if (!valid) return false;
        const updated =
          (
            await this.db.execute(
              "UPDATE panda_force_search_scopes SET active=?,commitId=?,documentCount=?,state='ready',failure=NULL,token=NULL,leaseUntil=NULL,updatedAt=? WHERE `key`=? AND token=? AND requested=? AND revision=? AND state='running' AND leaseUntil>?",
              [descriptor, commit, count, this.now(), row.key, row.token, row.requested, row.revision, this.now()],
            )
          ).changes === 1;
        if (updated && previous?.active && previous.active !== descriptor) {
          const retired = retiredGeneration(this.active(previous)!, decoded);
          if (retired)
            await this.db.execute("INSERT INTO panda_force_search_retired(descriptor,due) VALUES(?,?)", [
              JSON.stringify(retired),
              this.now() + 300000,
            ]);
        }
        if (updated) await this.progressStore.finish(row, "ready");
        return updated;
      });
    });
  }
  async fail(row: SearchJobRow, error: string) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const updated = await this.db.execute(
          "UPDATE panda_force_search_scopes SET state=?,failure=?,token=NULL,leaseUntil=NULL,updatedAt=? WHERE `key`=? AND token=? AND requested=?",
          [row.attempts < 3 ? "queued" : "failed", error, this.now(), row.key, row.token, row.requested],
        );
        if (updated.changes) await this.progressStore.finish(row, "failed");
      });
    });
  }
}
