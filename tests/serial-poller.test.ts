import { describe, expect, test } from "bun:test";
import { createSerialPoller } from "../src/client/serial-poller.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function timers() {
  let sequence = 0;
  const tasks = new Map();
  return {
    tasks,
    setTimer: (task, delay) => {
      const id = ++sequence;
      tasks.set(id, { task, delay });
      return id;
    },
    clearTimer: (id) => tasks.delete(id),
  };
}
describe("serial polling lifecycle", () => {
  test("a navigation reset invalidates both stale results and their finalizer", async () => {
    const old = deferred(),
      current = deferred(),
      clock = timers(),
      applied = [];
    let reads = 0;
    const poller = createSerialPoller({
      ...clock,
      interval: 100,
      isHidden: () => false,
      read: async (isCurrent) => {
        const index = reads++;
        await (index ? current.promise : old.promise);
        if (isCurrent()) applied.push(index);
      },
    });
    const first = poller.run();
    poller.reset();
    const second = poller.run();
    old.resolve();
    await first;
    expect(poller.pending).toBe(true);
    expect(clock.tasks.size).toBe(0);
    expect(applied).toEqual([]);
    current.resolve();
    await second;
    expect(poller.pending).toBe(false);
    expect(applied).toEqual([1]);
    expect(clock.tasks.size).toBe(1);
  });
  test("coalesces overlapping polls and slows down a hidden document", async () => {
    const read = deferred(),
      clock = timers();
    let count = 0;
    const poller = createSerialPoller({
      ...clock,
      interval: 100,
      hiddenInterval: 8000,
      isHidden: () => true,
      read: async () => {
        count++;
        await read.promise;
        return 250;
      },
    });
    const pending = poller.run();
    await poller.run();
    expect(count).toBe(1);
    read.resolve();
    await pending;
    expect([...clock.tasks.values()]).toHaveLength(1);
    expect([...clock.tasks.values()][0].delay).toBe(8000);
  });
  test("does not schedule disabled polling after logout", async () => {
    let enabled = true;
    const read = deferred(),
      clock = timers();
    const poller = createSerialPoller({
      ...clock,
      interval: 100,
      enabled: () => enabled,
      isHidden: () => false,
      read: () => read.promise,
    });
    const pending = poller.run();
    enabled = false;
    poller.reset();
    read.resolve();
    await pending;
    expect(clock.tasks.size).toBe(0);
    await poller.run();
    expect(clock.tasks.size).toBe(0);
  });
});
