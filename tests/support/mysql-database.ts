import { SQL } from "bun";
import { randomUUID } from "node:crypto";
/** Only creates and removes a generated schema on the expressly selected loopback test server. */
export async function isolatedMySQLDatabase(role: string) {
  const config = await Bun.file(process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE!).json();
  if (config.hostname !== "127.0.0.1" || config.database !== "panda_force_test" || !/^[a-z]{1,10}$/.test(role))
    throw Error("Dedicated local MySQL fixture required");
  const schema = "panda_force_test_" + role + "_" + randomUUID().replaceAll("-", "");
  const admin = new SQL({ ...config, adapter: "mysql", max: 2 });
  await admin.unsafe(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const sql = new SQL({ ...config, database: schema, adapter: "mysql", max: 8, connectionTimeout: 5, idleTimeout: 2 });
  return {
    sql,
    async close() {
      await sql.close({ timeout: 1 });
      await admin.unsafe(`DROP DATABASE ${schema}`);
      await admin.close({ timeout: 1 });
    },
  };
}
