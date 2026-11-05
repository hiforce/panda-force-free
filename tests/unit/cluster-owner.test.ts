import { expect, test } from "bun:test";
import { createClusterWorker } from "../../src/server/cluster/worker.js";
import type { ClusterConfig } from "../../src/server/cluster/config.js";
import type { CoordinationStore, OwnerLease } from "../../src/server/cluster/contracts.js";

const config: ClusterConfig = {
  role: "worker",
  workspace: "watchdog-test",
  nodeId: "owner",
  nodeUrl: "http://owner.test:8899",
  publicUrl: "https://panda.example.test",
  databaseUrl: "postgres://unused/test",
  secret: "test-secret-not-used-by-this-fixture",
  leaseMs: 120,
  requestTimeoutMs: 1000,
  recoverFence: null,
};

test("an independent deadline fences an owner even while its database renewal is stuck", async () => {
  let lost = 0,
    renewals = 0,
    releases = 0,
    executed = false,
    delivered = false;
  const lease: OwnerLease = {
    workspace: config.workspace,
    nodeId: config.nodeId,
    bootId: "boot",
    address: config.nodeUrl!,
    fence: 1,
    expiresAt: Date.now() + config.leaseMs,
    databaseNow: Date.now(),
    released: false,
  };
  const store: CoordinationStore = {
    initialize: async () => {},
    claimOwner: async () => lease,
    currentOwner: async () => lease,
    renew: () => {
      renewals++;
      return new Promise(() => {});
    },
    release: async () => {
      releases++;
    },
    acceptNonce: async () => true,
    appendEvent: async () => {
      throw Error("A fenced owner must not append events");
    },
    readEvents: async () => [],
    beginOperation: async () => ({ kind: "acquired" }),
    completeOperation: async () => {},
    close: async () => {},
  };
  const worker = await createClusterWorker(
    config,
    () => {
      lost++;
    },
    store,
  );
  try {
    await Bun.sleep(230);
    expect(renewals).toBe(1);
    expect(lost).toBe(1);
    expect(() => worker.assertOwner()).toThrow("unavailable");
    await expect(
      worker.dispatch({ type: "rpc", method: "thread/start" }, async () => {
        executed = true;
      }),
    ).rejects.toThrow("unavailable");
    worker.publish({ type: "event" }, () => {
      delivered = true;
    });
    expect(executed).toBe(false);
    expect(delivered).toBe(false);
    expect(lost).toBe(1);
  } finally {
    await worker.close(false);
  }
  expect(releases).toBe(0);
});
