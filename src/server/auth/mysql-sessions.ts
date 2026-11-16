import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { mysqlInteger } from "../database/mysql-model.js";
import type { SessionRevocations } from "./session-ports.js";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
type Watch = { expiresAt: number; callbacks: Set<() => void> };
/** Each request reads the revocation authority. Open connections additionally observe cross-replica logout through a bounded poll. */
export class MySQLSessionRevocations implements SessionRevocations {
  private readonly watchers = new Map<string, Watch>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | null = null;
  private closed = false;
  constructor(
    private readonly sql: SQL,
    private readonly now = Date.now,
    private readonly intervalMs = 1000,
  ) {}
  private closeWatch(key: string) {
    const callbacks = [...(this.watchers.get(key)?.callbacks ?? [])];
    this.watchers.delete(key);
    for (const close of callbacks) {
      try {
        close();
      } catch {}
    }
  }
  async has(token: string) {
    if (this.closed) throw Error("authStorageUnavailable");
    const r = (await this.sql`SELECT expires_at FROM panda_force_revoked_sessions WHERE digest=${digest(token)}`)[0];
    return !!r && mysqlInteger(r.expires_at) > this.now();
  }
  async revoke(token: string) {
    const expiresAt = Number(token.split(".")[0]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) return;
    if (this.closed) throw Error("authStorageUnavailable");
    const key = digest(token),
      now = this.now();
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM panda_force_revoked_sessions WHERE expires_at<=${now}`;
      await tx`INSERT INTO panda_force_revoked_sessions(digest,expires_at) VALUES(${key},${expiresAt}) ON DUPLICATE KEY UPDATE expires_at=GREATEST(expires_at,VALUES(expires_at))`;
    });
    this.closeWatch(key);
  }
  async watch(token: string, close: () => void) {
    const expiresAt = Number(token.split(".")[0]),
      key = digest(token);
    if (this.closed || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
      close();
      return () => {};
    }
    if (!this.watchers.has(key) && this.watchers.size >= 1024) {
      close();
      throw Error("authStorageUnavailable");
    }
    const value = this.watchers.get(key) ?? { expiresAt, callbacks: new Set<() => void>() };
    value.callbacks.add(close);
    this.watchers.set(key, value);
    const unwatch = () => {
      value.callbacks.delete(close);
      if (!value.callbacks.size && this.watchers.get(key) === value) this.watchers.delete(key);
    };
    try {
      if (await this.has(token)) {
        this.closeWatch(key);
        return () => {};
      }
    } catch (error) {
      unwatch();
      close();
      throw error;
    }
    if (this.closed) {
      unwatch();
      close();
      return () => {};
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.poll().catch(() => {
          for (const k of this.watchers.keys()) this.closeWatch(k);
        });
      }, this.intervalMs);
      this.timer.unref();
    }
    return unwatch;
  }
  async poll() {
    if (this.polling) return this.polling;
    if (this.closed) return;
    const pending = (async () => {
      const now = this.now();
      for (const [key, value] of this.watchers) if (value.expiresAt <= now) this.closeWatch(key);
      const keys = [...this.watchers.keys()];
      if (!keys.length) return;
      const rows = await this.sql.unsafe(
        "SELECT digest FROM panda_force_revoked_sessions WHERE expires_at>? AND digest IN (" +
          keys.map(() => "?").join(",") +
          ")",
        [now, ...keys],
      );
      if (this.closed) return;
      for (const row of rows) this.closeWatch(row.digest);
    })();
    this.polling = pending;
    try {
      await pending;
    } finally {
      if (this.polling === pending) this.polling = null;
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.watchers.clear();
  }
}
