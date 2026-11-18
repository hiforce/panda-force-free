import { expect, test } from "bun:test";
import { CreativeAssetSlots } from "../../src/server/creative/assets/slots.js";
const signal = () => new AbortController().signal;
test("native request bursts wait within per-owner and global limits while unrelated owners can use free slots", async () => {
  const slots = new CreativeAssetSlots(),
    a1 = await slots.acquire("a", signal()),
    a2 = await slots.acquire("a", signal());
  let aStarted = false;
  const a3 = slots.acquire("a", signal()).then((release) => {
    aStarted = true;
    return release;
  });
  const b1 = await slots.acquire("b", signal()),
    b2 = await slots.acquire("b", signal());
  expect(aStarted).toBe(false);
  const controller = new AbortController(),
    canceled = slots.acquire("c", controller.signal).then(
      () => "started",
      (error: unknown) => error,
    );
  controller.abort();
  expect(await canceled).toMatchObject({ code: "unavailable", status: 503 });
  const c = slots.acquire("c", signal());
  a1();
  const releaseA3 = await a3;
  expect(aStarted).toBe(true);
  b1();
  const releaseC = await c;
  a2();
  releaseA3();
  releaseC();
  b2();
  b2();
  const releases = await Promise.all(["a", "a", "b", "b"].map((owner) => slots.acquire(owner, signal())));
  expect(releases).toHaveLength(4);
  releases.forEach((release) => release());
});
test("bounded admission rejects excess queued work and canceled waiters never occupy a later slot", async () => {
  const slots = new CreativeAssetSlots(),
    active = await Promise.all(["a", "a", "b", "b"].map((owner) => slots.acquire(owner, signal()))),
    controllers = Array.from({ length: 24 }, () => new AbortController());
  const pending = controllers.map((controller, index) =>
    slots.acquire(index < 12 ? "a" : "b", controller.signal).then(
      () => "started",
      (error: unknown) => error,
    ),
  );
  await expect(slots.acquire("a", signal())).rejects.toMatchObject({ code: "busy", status: 429 });
  await expect(slots.acquire("c", signal())).rejects.toMatchObject({ code: "busy", status: 429 });
  controllers.forEach((controller) => controller.abort());
  for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: "unavailable" });
  active.forEach((release) => release());
  const release = await slots.acquire("a", signal());
  release();
  const aborted = new AbortController();
  aborted.abort();
  await expect(slots.acquire("a", aborted.signal)).rejects.toMatchObject({ code: "unavailable" });
});
