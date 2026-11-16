import type { SQL } from "bun";
type Connection = Awaited<ReturnType<SQL["reserve"]>>;

export async function assertApplicationMigrationLease(connection: Connection) {
  const row = (
    await connection`SELECT IS_USED_LOCK(CONCAT('pf-app:',LEFT(SHA2(DATABASE(),256),40)))=CONNECTION_ID() owned`
  )[0];
  if (Number(row?.owned) !== 1) throw Error("applicationMigrationLeaseLost");
}

/** File-only snapshot work must keep the reserved advisory-lock connection active as well. */
export async function withApplicationMigrationLease<T>(
  connection: Connection,
  idleSeconds: number,
  work: () => Promise<T>,
) {
  let pending: Promise<void> | undefined, failure: unknown;
  const timer = setInterval(
    () => {
      if (pending || failure) return;
      pending = assertApplicationMigrationLease(connection)
        .catch((error) => {
          failure = error;
        })
        .finally(() => {
          pending = undefined;
        });
    },
    Math.max(250, Math.min(5000, (idleSeconds * 1000) / 3)),
  );
  timer.unref();
  try {
    const result = await work();
    clearInterval(timer);
    await pending;
    if (failure) throw Error("applicationMigrationLeaseLost", { cause: failure });
    await assertApplicationMigrationLease(connection);
    return result;
  } finally {
    clearInterval(timer);
    await pending;
  }
}
