import type { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { SearchError } from "../../../shared/search/contracts.js";
import type { EmbeddingPolicy } from "./policy.js";

export const EMBEDDING_LEASE_MS = 60000;

/** Admission is atomic across workers and survives restart; failed calls never refund an uncertain provider charge. */
export class EmbeddingBudget {
  constructor(
    private db: Database,
    private policy: EmbeddingPolicy,
    private now = () => Date.now(),
  ) {}
  lock(namespace: string, token: string) {
    return (
      this.db
        .query(
          `INSERT INTO embedding_locks VALUES(?,?,?) ON CONFLICT(namespace) DO UPDATE SET token=excluded.token,untilAt=excluded.untilAt WHERE untilAt<=?`,
        )
        .run(namespace, token, this.now() + EMBEDDING_LEASE_MS, this.now()).changes === 1
    );
  }
  heartbeat(namespace: string, token: string) {
    return (
      this.db
        .query("UPDATE embedding_locks SET untilAt=? WHERE namespace=? AND token=?")
        .run(this.now() + EMBEDDING_LEASE_MS, namespace, token).changes === 1
    );
  }
  unlock(namespace: string, token: string) {
    this.db.query("DELETE FROM embedding_locks WHERE namespace=? AND token=?").run(namespace, token);
  }
  heartbeatCall(token: string) {
    return (
      this.db.query("UPDATE embedding_inflight SET untilAt=? WHERE token=?").run(this.now() + EMBEDDING_LEASE_MS, token)
        .changes === 1
    );
  }
  checkCooldown(model: string) {
    const blocked = this.db
      .query<{ untilAt: number }, [string]>("SELECT untilAt FROM embedding_backoff WHERE model=?")
      .get(model);
    if (blocked && blocked.untilAt > this.now()) throw new SearchError("limit", 429);
  }
  usage(owner: string) {
    const window = Math.floor(this.now() / 86400000),
      key = "owner-" + createHash("sha256").update(owner).digest("hex"),
      value = this.db
        .query<{ calls: number; characters: number }, [string, number]>(
          "SELECT calls,characters FROM embedding_usage WHERE bucket=? AND window=?",
        )
        .get(key, window);
    return {
      calls: value?.calls ?? 0,
      characters: value?.characters ?? 0,
      callLimit: this.policy.ownerCallsPerDay,
      characterLimit: this.policy.ownerCharactersPerDay,
      resetsAt: (window + 1) * 86400000,
    };
  }
  admit(model: string, owner: string, characters: number) {
    return this.db
      .transaction(() => {
        const now = this.now(),
          p = this.policy;
        this.db.query("DELETE FROM embedding_inflight WHERE untilAt<=?").run(now);
        this.checkCooldown(model);
        if (this.db.query<{ n: number }, []>("SELECT count(*) n FROM embedding_inflight").get()!.n >= p.concurrent)
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
          const current = this.db
            .query<{ calls: number; characters: number }, [string, number]>(
              "SELECT calls,characters FROM embedding_usage WHERE bucket=? AND window=?",
            )
            .get(q.bucket, q.window);
          if ((current?.calls ?? 0) + 1 > q.calls || (current?.characters ?? 0) + characters > q.characters)
            throw new SearchError("limit", 429);
        }
        for (const q of quotas)
          this.db
            .query(
              `INSERT INTO embedding_usage VALUES(?,?,1,?) ON CONFLICT(bucket,window) DO UPDATE SET calls=calls+1,characters=characters+excluded.characters`,
            )
            .run(q.bucket, q.window, characters);
        this.db
          .query("DELETE FROM embedding_usage WHERE (bucket='minute' AND window<?) OR (bucket!='minute' AND window<?)")
          .run(Math.floor(now / 60000) - 2, Math.floor(now / 86400000) - 2);
        const token = randomUUID();
        this.db
          .query("INSERT INTO embedding_inflight VALUES(?,?,?,?)")
          .run(token, model, now, now + EMBEDDING_LEASE_MS);
        return token;
      })
      .immediate();
  }
  complete(token: string, model: string, failure: boolean, ambiguous: boolean) {
    this.db
      .transaction(() => {
        const slot = this.db
          .query<{ startedAt: number }, [string, string]>(
            "SELECT startedAt FROM embedding_inflight WHERE token=? AND model=?",
          )
          .get(token, model);
        if (!slot) return;
        if (!ambiguous) this.db.query("DELETE FROM embedding_inflight WHERE token=?").run(token);
        if (!failure) {
          this.db.query("DELETE FROM embedding_backoff WHERE model=? AND untilAt<=?").run(model, slot.startedAt);
          return;
        }
        const previous = this.db
            .query<{ attempts: number; untilAt: number }, [string]>(
              "SELECT attempts,untilAt FROM embedding_backoff WHERE model=?",
            )
            .get(model),
          attempts = Math.min(10, (previous?.attempts ?? 0) + 1),
          delay = Math.max(
            ambiguous ? EMBEDDING_LEASE_MS : 0,
            Math.min(300000, this.policy.backoffSeconds * 1000 * 2 ** (attempts - 1)),
          );
        this.db
          .query(
            `INSERT INTO embedding_backoff VALUES(?,?,?) ON CONFLICT(model) DO UPDATE SET attempts=excluded.attempts,untilAt=max(untilAt,excluded.untilAt)`,
          )
          .run(model, attempts, this.now() + delay);
      })
      .immediate();
  }
}
