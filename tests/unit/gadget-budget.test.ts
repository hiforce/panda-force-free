import { test, expect } from "bun:test";
import { GadgetDataBudget } from "../../src/client/gadget/data.js";
test("registered gadgets share a four-request budget, coalesce reads and release canceled waiters", async () => {
  const budget = new GadgetDataBudget(),
    control = new AbortController();
  let active = 0,
    max = 0,
    calls = 0;
  const releases: Array<() => void> = [];
  const work = () =>
    new Promise<number>((resolve) => {
      calls++;
      active++;
      max = Math.max(max, active);
      releases.push(() => {
        active--;
        resolve(calls);
      });
    });
  const reads = Array.from({ length: 12 }, () => budget.run(control.signal, work));
  await Bun.sleep(0);
  expect(calls).toBe(4);
  const canceled = new AbortController(),
    waiting = budget.run(canceled.signal, work);
  canceled.abort();
  await expect(waiting).rejects.toThrow();
  for (let n = 0; n < 12; n++) {
    releases.shift()!();
    await Bun.sleep(0);
  }
  await Promise.all(reads);
  expect(max).toBe(4);
  let count = 0;
  const a = budget.read("same", 60, control.signal, async () => ++count),
    b = budget.read("same", 60, control.signal, async () => ++count);
  expect(await a).toBe(1);
  expect(await b).toBe(1);
  expect(count).toBe(1);
});
