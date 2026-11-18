import { expect, test } from "bun:test";
import { CreationRenderingSlots } from "../../src/server/creation/integration/rendering/slots.js";
const signal = () => new AbortController().signal;
test("rendering slots bound active work, coalesce capacity after queue cancellation and retain an aborted active operation until cleanup", async () => {
  const slots = new CreationRenderingSlots(1, 2),
    active = new AbortController(),
    queued = new AbortController();
  let release!: () => void,
    thirdStarted = false,
    cancelledStarted = false;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    first = slots.run(active.signal, () => held),
    second = slots.run(queued.signal, async () => {
      cancelledStarted = true;
    }),
    third = slots.run(signal(), async () => {
      thirdStarted = true;
      return "third";
    });
  await expect(slots.run(signal(), async () => "overflow")).rejects.toThrow("busy");
  queued.abort(Error("Queued render cancelled"));
  await expect(second).rejects.toThrow("Queued render cancelled");
  active.abort(Error("Active render cancelled"));
  await Bun.sleep(10);
  expect(cancelledStarted).toBe(false);
  expect(thirdStarted).toBe(false);
  release();
  await expect(first).rejects.toThrow("Active render cancelled");
  expect(await third).toBe("third");
  expect(await slots.run(signal(), async () => "healthy")).toBe("healthy");
});
