import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";

export function distinctLegacyRevocations(target: string, source?: string): source is string {
  return Boolean(
    source && existsSync(source) && (!existsSync(target) || realpathSync(source) !== realpathSync(target)),
  );
}

/** Copy live revocation digests transactionally. The legacy database is always opened read-only. */
export function importRevocations(target: Database, source: string, now: number) {
  const legacy = new Database(source, { readonly: true, strict: true });
  try {
    const rows = legacy.query<{ digest: string; expires_at: number }, [number]>(
      "SELECT digest,expires_at FROM revoked_sessions WHERE expires_at>?",
    );
    const write = target.query(
      "INSERT INTO revoked_sessions VALUES(?,?) ON CONFLICT(digest) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)",
    );
    target
      .transaction(() => {
        for (const row of rows.iterate(now)) {
          if (!/^[a-f0-9]{64}$/.test(row.digest) || !Number.isSafeInteger(row.expires_at))
            throw new Error("Invalid legacy session revocation record");
          write.run(row.digest, row.expires_at);
        }
      })
      .immediate();
  } finally {
    legacy.close();
  }
}
