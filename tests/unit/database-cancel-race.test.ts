import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  DatabaseManagementState,
  type StoredDatabaseOperation,
  type StoredDatabasePlan,
} from "../../src/server/database/management/state.js";
import { DatabaseManagementService } from "../../src/server/database/management/service.js";
import { DatabaseRegistry } from "../../src/server/database/registry.js";
import { executeApplicationMigration } from "../../src/server/database/migration/coordinator.js";

test("a backend gate failure cannot resurrect a cancellation completed while reading its plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pf-db-cancel-race-"));
  try {
    const state = new DatabaseManagementState(root),
      id = randomUUID(),
      planId = randomUUID(),
      owner = "a".repeat(64),
      token = "T".repeat(43),
      now = Date.now(),
      registry = new DatabaseRegistry().register({
        id: "fixture",
        dependencies: [],
        migrations: {},
        inspect: async () => [],
      });
    const plan: StoredDatabasePlan = {
      schema: 1,
      owner,
      config: {
        schema: 1,
        driver: "mysql",
        mysql: {
          hostname: "127.0.0.1",
          port: 3306,
          database: "unused",
          username: "unused",
          password: "unused",
          tls: { mode: "disabled" },
          max: 2,
          connectionTimeout: 5,
          idleTimeout: 30,
        },
      },
      public: {
        id: planId,
        source: { driver: "sqlite" },
        target: { driver: "mysql" },
        restartRequired: true,
        ready: true,
        modules: [],
        issues: [],
        expiresAt: now + 60000,
      },
    };
    const operation: StoredDatabaseOperation = {
      schema: 1,
      owner,
      planId,
      statusTokenHash: createHash("sha256").update(token).digest("hex"),
      tokenExpiresAt: now + 60000,
      public: {
        id,
        status: "waiting-restart",
        stage: "restart",
        source: { driver: "sqlite" },
        target: { driver: "mysql" },
        modules: [],
        startedAt: now,
        updatedAt: now,
        canRetry: false,
        canCancel: true,
      },
    };
    await state.write("plans", planId, plan);
    await state.write("operations", id, operation);
    await state.write("", "pending", { operationId: id });
    const service = new DatabaseManagementService({
      state,
      registry: () => registry,
      runtimeBindings: () => new Set(),
      current: () => ({ driver: "sqlite" }),
      initialChoiceRequired: false,
      tableCount: () => 0,
    });
    const read = state.read.bind(state);
    state.read = async function <T>(area: "plans" | "operations" | "", name: string): Promise<T | null> {
      if (area === "plans") {
        await service.cancel(id, token);
      }
      return read<T>(area, name);
    };
    let connected = false;
    const result = await executeApplicationMigration({
      state,
      operationId: id,
      registry,
      runtimeBindings: new Set(),
      current: { schema: 1, driver: "sqlite" },
      units: [],
      prepare: async () => {
        throw Error("Must not capture");
      },
      connect: async () => {
        connected = true;
        throw Error("Must not connect");
      },
    });
    expect(result.status).toBe("canceled");
    expect(connected).toBe(false);
    expect((await read<StoredDatabaseOperation>("operations", id))?.public.status).toBe("canceled");
    expect(await read("", "pending")).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
