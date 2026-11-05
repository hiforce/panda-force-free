import { beforeAll, afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPostgresFixture } from "../support/postgres-fixture.js";
import { createPostgresCoordination } from "../../src/server/cluster/postgres.js";
import type { CoordinationStore } from "../../src/server/cluster/contracts.js";

let fixture: Awaited<ReturnType<typeof createPostgresFixture>>;
let a: CoordinationStore, b: CoordinationStore;
beforeAll(async () => {
  fixture = await createPostgresFixture();
  a = createPostgresCoordination(fixture.url);
  b = createPostgresCoordination(fixture.url);
  await Promise.all([a.initialize(), b.initialize()]);
}, 40_000);
afterAll(async () => {
  await a?.close();
  await b?.close();
  await fixture?.dispose();
}, 15_000);
const input = () => ({
  workspace: "test-" + randomUUID(),
  nodeId: "a",
  bootId: randomUUID(),
  address: "http://owner.test:8899",
  leaseMs: 10_000,
});

test("only one owner can claim a workspace; transfer fences old writes and preserves shared events", async () => {
  const options = input();
  const owner = await a.claimOwner(options);
  await expect(b.claimOwner({ ...options, nodeId: "b", bootId: randomUUID() })).rejects.toThrow(
    "previous workspace owner",
  );
  const event = await a.appendEvent(owner, { type: "example", text: "native output" });
  expect((await b.readEvents(options.workspace, owner.fence, 0))[0]).toEqual(event);
  await a.release(owner);
  const next = await b.claimOwner({ ...options, nodeId: "b", bootId: randomUUID() });
  expect(next.fence).toBe(owner.fence + 1);
  await expect(a.appendEvent(owner, { type: "stale" })).rejects.toThrow("ownership");
  expect(await b.readEvents(options.workspace, owner.fence, 0)).toEqual([event]);
  expect(await b.readEvents("another-workspace", owner.fence, 0)).toEqual([]);
  await b.release(next);
});

test("expired ownership requires explicit confirmed-stop recovery and cannot resurrect itself", async () => {
  const options = { ...input(), leaseMs: 100 };
  const owner = await a.claimOwner(options);
  await Bun.sleep(180);
  expect(await b.currentOwner(options.workspace)).toBeNull();
  await expect(a.renew(owner, 10_000)).rejects.toThrow("ownership");
  await expect(b.claimOwner({ ...options, bootId: randomUUID() })).rejects.toThrow("previous workspace owner");
  const next = await b.claimOwner({ ...options, bootId: randomUUID(), leaseMs: 10_000, recoverFence: owner.fence });
  expect(next.fence).toBe(owner.fence + 1);
  await b.release(next);
});

test("duplicate approvals and uncertain writes are durable and never become executable again", async () => {
  const options = input(),
    owner = await a.claimOwner(options),
    id = randomUUID();
  expect(await a.beginOperation(owner, id, "digest-a")).toEqual({ kind: "acquired" });
  expect(await b.beginOperation(owner, id, "digest-a")).toEqual({ kind: "uncertain" });
  expect(await b.beginOperation(owner, id, "digest-b")).toEqual({ kind: "conflict" });
  await a.completeOperation(owner, id, "digest-a", { type: "ack" });
  expect(await b.beginOperation(owner, id, "digest-a")).toEqual({ kind: "completed", result: { type: "ack" } });
  const uncertain = randomUUID();
  await a.beginOperation(owner, uncertain, "unfinished");
  await a.release(owner);
  const next = await b.claimOwner({ ...options, bootId: randomUUID() });
  expect(await b.beginOperation(next, uncertain, "unfinished")).toEqual({ kind: "uncertain" });
  expect(await a.acceptNonce(next, "nonce")).toBe(true);
  expect(await b.acceptNonce(next, "nonce")).toBe(false);
  await b.release(next);
});
