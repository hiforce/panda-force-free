import { expect, test } from "bun:test";
import { retryMySQLConnection, mysqlConnectionFailure } from "../../src/server/database/connection-policy.js";
import { createDatabaseReadiness } from "../../src/server/database/health.js";
import type { SQL } from "bun";

test("transient connection recovery is bounded and uses exponential jitter instead of a tight loop", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const value = await retryMySQLConnection(
    async () => {
      if (++attempts < 4) throw Object.assign(new Error("temporary"), { code: "ECONNRESET" });
      return "connected";
    },
    { attempts: 4, baseDelayMs: 1000, maxDelayMs: 2500 },
    {
      wait: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    },
  );
  expect(value).toBe("connected");
  expect(delays).toEqual([900, 1800, 2250]);
  attempts = 0;
  await expect(
    retryMySQLConnection(
      async () => {
        attempts++;
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
      { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      { wait: async () => {} },
    ),
  ).rejects.toThrow("refused");
  expect(attempts).toBe(3);
});

test("host blocks, initial protocol rejections and authentication failures never create a retry storm", async () => {
  for (const error of [
    Object.assign(new Error("blocked"), { errno: 1129 }),
    Object.assign(new Error("rejected before authentication"), { code: "ERR_MYSQL_UNSUPPORTED_PROTOCOL_VERSION" }),
    Object.assign(new Error("access denied"), { errno: 1045, code: "ERR_MYSQL_ACCESS_DENIED_ERROR" }),
    new Error("unsupportedDatabaseServer"),
  ]) {
    let attempts = 0,
      sleeps = 0;
    await expect(
      retryMySQLConnection(
        async () => {
          attempts++;
          throw error;
        },
        { attempts: 6, baseDelayMs: 1, maxDelayMs: 10 },
        {
          wait: async () => {
            sleeps++;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(sleeps).toBe(0);
    expect(mysqlConnectionFailure(error)).not.toBe("transient");
  }
});

test("readiness coalesces slow probes, cancels timeouts and recovers after its cooldown", async () => {
  let time = 0,
    queries = 0,
    canceled = 0,
    fail = true;
  const sql = {
    unsafe: () => {
      queries++;
      if (!fail) return Object.assign(Promise.resolve([{ ready: 1 }]), { cancel() {} });
      return Object.assign(new Promise(() => {}), {
        cancel() {
          canceled++;
        },
      });
    },
  } as unknown as SQL;
  const ready = createDatabaseReadiness(sql, { now: () => time, timeoutMs: 10 });
  expect(await Promise.all([ready(), ready(), ready()])).toEqual([false, false, false]);
  expect(queries).toBe(1);
  expect(canceled).toBe(1);
  expect(await ready()).toBe(false);
  expect(queries).toBe(1);
  time = 5000;
  expect(await ready()).toBe(false);
  expect(queries).toBe(2);
  time = 14999;
  expect(await ready()).toBe(false);
  expect(queries).toBe(2);
  fail = false;
  time = 15000;
  expect(await ready()).toBe(true);
  expect(queries).toBe(3);
  expect(await ready()).toBe(true);
  expect(queries).toBe(3);
  expect(await createDatabaseReadiness(null)()).toBe(true);
});
