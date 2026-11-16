import type { SQL } from "bun";

/** Readiness shares the application pool, coalesces probes and backs off after a failure. Liveness is independent. */
export function createDatabaseReadiness(sql: SQL | null, options: { now?: () => number; timeoutMs?: number } = {}) {
  const now = options.now ?? Date.now;
  let result = sql === null,
    next = 0,
    failures = 0,
    pending: Promise<boolean> | null = null;
  return function ready(): Promise<boolean> {
    if (!sql) return Promise.resolve(true);
    if (pending) return pending;
    if (now() < next) return Promise.resolve(result);
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const query = sql.unsafe("SELECT 1 AS ready");
        const checked = Promise.resolve(query).then(
          () => true,
          () => false,
        );
        result = await Promise.race([
          checked,
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
              try {
                query.cancel();
              } catch {
                /* A concurrent connection close already rejected this query. */
              }
              resolve(false);
            }, options.timeoutMs ?? 2000);
          }),
        ]);
      } catch {
        result = false;
      } finally {
        clearTimeout(timer);
      }
      failures = result ? 0 : Math.min(failures + 1, 4);
      next = now() + (result ? 5000 : Math.min(30000, 5000 * 2 ** (failures - 1)));
      return result;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
