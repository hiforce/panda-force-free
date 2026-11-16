import type { SQL } from "bun";
/** A read snapshot must be stable even when the shared server defaults to READ COMMITTED. Session defaults and other applications stay unchanged. */
export async function consistentMySQLRead<T>(pool: SQL, work: (sql: SQL) => Promise<T>): Promise<T> {
  const connection = await pool.reserve();
  try {
    await connection.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return await connection.begin(work);
  } finally {
    connection.release();
  }
}
