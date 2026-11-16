import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchResourceScans } from "../../src/server/search/storage/resource-scans.js";
import { SearchIndexResources, resourceGraceMs } from "../../src/server/search/storage/resources.js";
import { IndexResourceLifecycle } from "../../src/server/search/resources/lifecycle.js";
import { ResourceScanRunner } from "../../src/server/search/resources/scan-runner.js";
import { reconcileIndexResources } from "../../src/server/search/resources/inventory.js";
import type { PhysicalIndexStorage } from "../../src/server/search/resources/contracts.js";

const storage = "a".repeat(64),
  name = "b".repeat(64);
async function until(condition: () => boolean) {
  const end = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > end) throw Error("Worker did not reach the expected checkpoint");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function fixture() {
  const db = openSearchDatabase(":memory:");
  let now = 1000000,
    calls = 0;
  const scans = new SearchResourceScans(db, () => now),
    registry = new SearchIndexResources(db, () => now),
    errors: unknown[] = [];
  let inventory: PhysicalIndexStorage["inventory"] = async () => ({ names: [], next: null, ownedNamespaceCount: 0 });
  const physical: PhysicalIndexStorage = {
      id: storage,
      inspect: async () => ({ name, identity: "448707763883002001", marker: "owned-allocation" }),
      remove: async () => {
        throw Error("Remote delete unavailable");
      },
      inventory: async (cursor, signal) => {
        calls++;
        return inventory(cursor, signal);
      },
    },
    owner = new IndexResourceLifecycle(
      registry,
      physical,
      async () => {},
      (e) => errors.push(e),
    );
  return {
    db,
    scans,
    registry,
    owner,
    errors,
    calls: () => calls,
    tick: (ms: number) => {
      now += ms;
    },
    setInventory: (value: typeof inventory) => {
      inventory = value;
    },
    runner: () =>
      new ResourceScanRunner(
        scans,
        () => [{ connection: "vectors", owner, automatic: false }],
        (e) => errors.push(e),
      ),
  };
}

test("connection aliases share one scan and an unused alias cannot disable a used storage's automatic check", async () => {
  const f = fixture(),
    runner = new ResourceScanRunner(
      f.scans,
      () => [
        { connection: "active", owner: f.owner, automatic: true, preferred: true },
        { connection: "unused", owner: f.owner, automatic: false },
      ],
      (error) => f.errors.push(error),
    );
  try {
    runner.kick();
    await until(() => f.scans.view(storage, true).state === "ready");
    expect(f.calls()).toBe(1);
    expect(f.errors).toEqual([]);
  } finally {
    await runner.close();
    f.db.close();
  }
});

test("manual scans use the selected credential profile; duplicate receipts cannot change it and later automatic cycles prefer the active profile", async () => {
  const f = fixture();
  let selectedCalls = 0;
  const selected = new IndexResourceLifecycle(
      f.registry,
      {
        ...f.owner.storage,
        inventory: async () => {
          selectedCalls++;
          return { names: [], next: null, ownedNamespaceCount: 0 };
        },
      },
      async () => {},
      (error) => f.errors.push(error),
    ),
    runner = new ResourceScanRunner(
      f.scans,
      () => [
        { connection: "active", owner: f.owner, automatic: true, preferred: true },
        { connection: "rotated", owner: selected, automatic: true },
      ],
      (error) => f.errors.push(error),
    ),
    operation = randomUUID();
  try {
    f.scans.request(storage, operation, "rotated");
    f.scans.request(storage, operation, "active");
    expect(f.scans.connection(storage)).toBe("rotated");
    runner.kick();
    await until(() => f.scans.view(storage, true).state === "ready");
    expect(selectedCalls).toBe(1);
    expect(f.calls()).toBe(0);
    f.tick(300001);
    runner.kick();
    await until(() => f.calls() === 1);
    await until(() => f.scans.view(storage, true).state === "ready");
    expect(selectedCalls).toBe(1);
    expect(f.errors).toEqual([]);
  } finally {
    await runner.close();
    f.db.close();
  }
});

test("a missing selected profile reports configuration without falling back to another credential; an explicit retry can replace it", async () => {
  const f = fixture(),
    runner = f.runner();
  try {
    f.scans.request(storage, randomUUID(), "missing-profile");
    runner.kick();
    await until(() => f.scans.view(storage, false).state === "failed");
    expect(f.calls()).toBe(0);
    expect(f.scans.view(storage, false).failure).toBe("configuration");
    f.scans.request(storage, randomUUID(), "vectors");
    runner.kick();
    await until(() => f.scans.view(storage, false).state === "ready");
    expect(f.calls()).toBe(1);
  } finally {
    await runner.close();
    f.db.close();
  }
});

test("unused storage performs no background IO; repeated checks join the running task without blocking the caller", async () => {
  const f = fixture(),
    runner = f.runner();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setInventory(async () => {
    await gate;
    return { names: [], next: null, ownedNamespaceCount: 0 };
  });
  try {
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.calls()).toBe(0);
    f.scans.request(storage, randomUUID());
    runner.kick();
    await until(() => f.calls() === 1);
    expect(f.scans.view(storage, false).state).toBe("running");
    for (let i = 0; i < 5; i++) {
      f.scans.request(storage, randomUUID());
      runner.kick();
    }
    expect(f.calls()).toBe(1);
    release();
    await until(() => f.scans.view(storage, false).state === "ready");
    await runner.close();
    expect(f.calls()).toBe(1);
    expect(f.errors).toEqual([]);
  } finally {
    release();
    await runner.close();
    f.db.close();
  }
});

test("shutdown cancels physical IO and a new worker resumes the same task after its lease expires", async () => {
  const f = fixture(),
    runner = f.runner();
  let resumed: ReturnType<typeof f.runner> | undefined,
    aborted = false;
  f.setInventory(
    async (_cursor, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  try {
    f.scans.request(storage, randomUUID());
    runner.kick();
    await until(() => f.calls() === 1);
    await runner.close();
    expect(aborted).toBeTrue();
    expect(f.scans.view(storage, false).state).toBe("running");
    f.tick(120001);
    f.setInventory(async () => ({ names: [], next: null, ownedNamespaceCount: 0 }));
    resumed = f.runner();
    resumed.kick();
    await until(() => f.scans.view(storage, false).state === "ready");
    expect(f.calls()).toBe(2);
    expect(f.errors).toEqual([]);
  } finally {
    await runner.close();
    await resumed?.close();
    f.db.close();
  }
});

test("a failed cleanup remains an unavailable observation and cannot certify a completed healthy scan", async () => {
  const f = fixture();
  try {
    f.setInventory(async () => ({ names: [name], next: null, ownedNamespaceCount: 1 }));
    const reservation = f.registry.reserve(storage, name, "recipe", "owned-allocation");
    f.registry.release({ storage, name, token: reservation.token! });
    await reconcileIndexResources(f.owner, { physical: "", allocations: "" }, AbortSignal.timeout(1000), (e) =>
      f.errors.push(e),
    );
    f.tick(resourceGraceMs + 1);
    const batch = await reconcileIndexResources(
      f.owner,
      { physical: "", allocations: "" },
      AbortSignal.timeout(1000),
      (e) => f.errors.push(e),
    );
    expect(batch.observations).toEqual([{ name, status: "unavailable", missing: false }]);
    expect(batch.report.failed).toBe(1);
    f.scans.request(storage, randomUUID());
    f.scans.finish(f.scans.claim(storage, false)!, batch.next, batch.observations);
    expect(f.scans.view(storage, false).state).toBe("failed");
    expect(f.scans.view(storage, false).summary.failed).toBe(1);
  } finally {
    f.db.close();
  }
});

test("inventory bounds independent reads and drains all canceled IO before its batch rejects", async () => {
  const f = fixture(),
    controller = new AbortController();
  let active = 0,
    maximum = 0,
    calls = 0,
    settled = false,
    release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setInventory(async () => ({ names: [name, "c".repeat(64), "d".repeat(64)], next: null, ownedNamespaceCount: 3 }));
  f.owner.storage.inspect = async (_name, signal) => {
    const index = calls++;
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
      return null;
    } finally {
      if (index === 1) await cleanup;
      active--;
    }
  };
  const work = reconcileIndexResources(f.owner, { physical: "", allocations: "" }, controller.signal, () => {}).finally(
    () => {
      settled = true;
    },
  );
  const rejected = work.then(
    () => null,
    (error) => error,
  );
  try {
    await until(() => active === 2);
    controller.abort(Error("stop inventory"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBeFalse();
    expect(active).toBe(1);
    release();
    expect(await rejected).toMatchObject({ message: "stop inventory" });
    expect(maximum).toBe(2);
    expect(calls).toBe(2);
    expect(active).toBe(0);
  } finally {
    controller.abort();
    release();
    await work.catch(() => {});
    f.db.close();
  }
});
