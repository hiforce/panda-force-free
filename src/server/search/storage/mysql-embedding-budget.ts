import type { MySQLMetadataContext } from "../../knowledge/storage/mysql-context.js";

import { randomUUID, createHash } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import type { EmbeddingPolicy } from "../embeddings/policy.js";
export const EMBEDDING_LEASE_MS = 60000;
/** Admission is atomic across workers and survives restart; failed calls never refund an uncertain provider charge. */
export class MySQLEmbeddingBudget {
  constructor(
    private db: MySQLMetadataContext,
    private policy: EmbeddingPolicy,
    private now = () => Date.now(),
  ) {}
  async lock(namespace: string, token: string) {
    return await this.db.atomic(async () => {
      const old = await this.db.one<{
        untilAt: number;
      }>("SELECT untilAt FROM panda_force_embedding_locks WHERE namespace=?", [namespace]);
      if (old && old.untilAt > this.now()) return false;
      await this.db.execute(
        "INSERT INTO panda_force_embedding_locks(namespace,token,untilAt) VALUES(?,?,?) ON DUPLICATE KEY UPDATE token=VALUES(token),untilAt=VALUES(untilAt)",
        [namespace, token, this.now() + EMBEDDING_LEASE_MS],
      );
      return true;
    });
  }
  async heartbeat(namespace: string, token: string) {
    return this.db.atomic(async () => {
      const row = await this.db.one(
        "SELECT 1 FROM panda_force_embedding_locks WHERE namespace=? AND token=? AND untilAt>?",
        [namespace, token, this.now()],
      );
      if (!row) return false;
      await this.db.execute("UPDATE panda_force_embedding_locks SET untilAt=? WHERE namespace=? AND token=?", [
        this.now() + EMBEDDING_LEASE_MS,
        namespace,
        token,
      ]);
      return true;
    });
  }
  async unlock(namespace: string, token: string) {
    return await this.db.atomic(async () => {
      await this.db.execute("DELETE FROM panda_force_embedding_locks WHERE namespace=? AND token=?", [
        namespace,
        token,
      ]);
    });
  }
  async heartbeatCall(token: string) {
    return this.db.atomic(async () => {
      const row = await this.db.one("SELECT 1 FROM panda_force_embedding_inflight WHERE token=? AND untilAt>?", [
        token,
        this.now(),
      ]);
      if (!row) return false;
      await this.db.execute("UPDATE panda_force_embedding_inflight SET untilAt=? WHERE token=?", [
        this.now() + EMBEDDING_LEASE_MS,
        token,
      ]);
      return true;
    });
  }
  async checkCooldown(model: string) {
    return await this.db.atomic(async () => {
      const blocked = await this.db.one<{
        untilAt: number;
      }>("SELECT untilAt FROM panda_force_embedding_backoff WHERE model=?", [model]);
      if (blocked && blocked.untilAt > this.now()) throw new SearchError("limit", 429);
    });
  }
  async usage(owner: string) {
    return await this.db.atomic(async () => {
      const window = Math.floor(this.now() / 86400000),
        key = "owner-" + createHash("sha256").update(owner).digest("hex"),
        value = await this.db.one<{
          calls: number;
          characters: number;
        }>("SELECT calls,characters FROM panda_force_embedding_usage WHERE bucket=? AND `window`=?", [key, window]);
      return {
        calls: value?.calls ?? 0,
        characters: value?.characters ?? 0,
        callLimit: this.policy.ownerCallsPerDay,
        characterLimit: this.policy.ownerCharactersPerDay,
        resetsAt: (window + 1) * 86400000,
      };
    });
  }
  async admit(model: string, owner: string, characters: number) {
    return await this.db.atomic(async () => {
      return await this.db.atomic(async () => {
        const now = this.now(),
          p = this.policy;
        await this.db.execute("DELETE FROM panda_force_embedding_inflight WHERE untilAt<=?", [now]);
        await this.checkCooldown(model);
        if (
          (await this.db.one<{
            n: number;
          }>("SELECT count(*) n FROM panda_force_embedding_inflight", []))!.n >= p.concurrent
        )
          throw new SearchError("limit", 429);
        const ownerKey = createHash("sha256").update(owner).digest("hex"),
          quotas = [
            { bucket: "minute", window: Math.floor(now / 60000), calls: p.callsPerMinute, characters: Infinity },
            { bucket: "day", window: Math.floor(now / 86400000), calls: p.callsPerDay, characters: p.charactersPerDay },
            {
              bucket: "owner-" + ownerKey,
              window: Math.floor(now / 86400000),
              calls: p.ownerCallsPerDay,
              characters: p.ownerCharactersPerDay,
            },
          ];
        for (const q of quotas) {
          const current = await this.db.one<{
            calls: number;
            characters: number;
          }>("SELECT calls,characters FROM panda_force_embedding_usage WHERE bucket=? AND `window`=?", [
            q.bucket,
            q.window,
          ]);
          if ((current?.calls ?? 0) + 1 > q.calls || (current?.characters ?? 0) + characters > q.characters)
            throw new SearchError("limit", 429);
        }
        for (const q of quotas)
          await this.db.execute(
            `INSERT INTO panda_force_embedding_usage VALUES(?,?,1,?) ON DUPLICATE KEY UPDATE calls=calls+1,characters=characters+VALUES(characters)`,
            [q.bucket, q.window, characters],
          );
        await this.db.execute(
          "DELETE FROM panda_force_embedding_usage WHERE (bucket='minute' AND `window`<?) OR (bucket!='minute' AND `window`<?)",
          [Math.floor(now / 60000) - 2, Math.floor(now / 86400000) - 2],
        );
        const token = randomUUID();
        await this.db.execute("INSERT INTO panda_force_embedding_inflight VALUES(?,?,?,?)", [
          token,
          model,
          now,
          now + EMBEDDING_LEASE_MS,
        ]);
        return token;
      });
    });
  }
  async complete(token: string, model: string, failure: boolean, ambiguous: boolean) {
    return await this.db.atomic(async () => {
      await this.db.atomic(async () => {
        const slot = await this.db.one<{
          startedAt: number;
        }>("SELECT startedAt FROM panda_force_embedding_inflight WHERE token=? AND model=?", [token, model]);
        if (!slot) return;
        if (!ambiguous) await this.db.execute("DELETE FROM panda_force_embedding_inflight WHERE token=?", [token]);
        if (!failure) {
          await this.db.execute("DELETE FROM panda_force_embedding_backoff WHERE model=? AND untilAt<=?", [
            model,
            slot.startedAt,
          ]);
          return;
        }
        const previous = await this.db.one<{
            attempts: number;
            untilAt: number;
          }>("SELECT attempts,untilAt FROM panda_force_embedding_backoff WHERE model=?", [model]),
          attempts = Math.min(10, (previous?.attempts ?? 0) + 1),
          delay = Math.max(
            ambiguous ? EMBEDDING_LEASE_MS : 0,
            Math.min(300000, this.policy.backoffSeconds * 1000 * 2 ** (attempts - 1)),
          );
        await this.db.execute(
          `INSERT INTO panda_force_embedding_backoff VALUES(?,?,?) ON DUPLICATE KEY UPDATE attempts=VALUES(attempts),untilAt=GREATEST(untilAt,VALUES(untilAt))`,
          [model, attempts, this.now() + delay],
        );
      });
    });
  }
}
