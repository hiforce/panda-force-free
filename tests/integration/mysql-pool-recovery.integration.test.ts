import { expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { join, dirname, resolve } from "node:path";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { databaseConfiguration } from "../../src/server/database/config.js";
import { connectMySQL } from "../../src/server/database/provider.js";
import { createDatabaseReadiness } from "../../src/server/database/health.js";

const guarded = test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE);
guarded(
  "one bounded pool recovers from lost connections and readiness recovers without replaying a write",
  async () => {
    const database = await isolatedMySQLDatabase("pool");
    const input = await Bun.file(process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE!).json();
    const sockets = new Set<Socket>();
    let available = true;
    const proxy = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      if (!available) {
        socket.destroy();
        return;
      }
      const upstream = connect(input.port, input.hostname);
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw Error("Missing proxy port");
    let pool: Awaited<ReturnType<typeof connectMySQL>> | undefined;
    try {
      const schema = (await database.sql.unsafe("SELECT DATABASE() selected"))[0].selected;
      const config = databaseConfiguration({
        schema: 1,
        driver: "mysql",
        mysql: {
          hostname: "127.0.0.1",
          port: address.port,
          database: schema,
          username: input.username,
          password: input.password,
          tls: {
            mode: "verify",
            caFile: join(
              dirname(resolve(process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE!)),
              "mysql-tls",
              "server-cert.pem",
            ),
          },
          max: 2,
          idleTimeout: 5,
          connectionTimeout: 2,
          maxLifetime: 60,
        },
      });
      if (config.driver !== "mysql") throw Error("Expected MySQL");
      pool = await connectMySQL(config);
      const rows = await Promise.all(
        Array.from({ length: 12 }, () => pool!.unsafe("SELECT CONNECTION_ID() id,SLEEP(0.02) waited")),
      );
      expect(new Set(rows.map((row) => row[0].id)).size).toBeLessThanOrEqual(2);
      await pool.unsafe("CREATE TABLE marker (id INT PRIMARY KEY)");
      await pool.unsafe("INSERT INTO marker VALUES (1)");
      let time = 0;
      const ready = createDatabaseReadiness(pool, { now: () => time, timeoutMs: 200 });
      expect(await ready()).toBe(true);
      available = false;
      for (const socket of sockets) socket.destroy();
      await Bun.sleep(20);
      time = 5000;
      expect(await ready()).toBe(false);
      available = true;
      time = 35000;
      expect(await ready()).toBe(true);
      expect(Number((await pool.unsafe("SELECT COUNT(*) count FROM marker"))[0].count)).toBe(1);
    } finally {
      await pool?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await database.close();
    }
  },
  30000,
);

test("a pre-authentication host-block packet produces an actionable failure and is not retried", async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    const payload = Buffer.concat([
      Buffer.from([255, 105, 4]),
      Buffer.from("#HY000Host is blocked because of many connection errors"),
    ]);
    const packet = Buffer.alloc(payload.length + 4);
    packet.writeUIntLE(payload.length, 0, 3);
    payload.copy(packet, 4);
    socket.on("error", () => {});
    socket.end(packet);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test port");
  try {
    const config = databaseConfiguration({
      schema: 1,
      driver: "mysql",
      mysql: {
        hostname: "127.0.0.1",
        port: address.port,
        database: "fixture",
        username: "fixture",
        password: "unused",
        tls: { mode: "disabled" },
        max: 2,
      },
    });
    if (config.driver !== "mysql") throw Error("Expected MySQL");
    await expect(connectMySQL(config, { attempts: 6, baseDelayMs: 1, maxDelayMs: 10 })).rejects.toThrow(
      /mysqlHostBlocked|mysqlHandshakeRejected/,
    );
    expect(connections).toBeLessThanOrEqual(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);
