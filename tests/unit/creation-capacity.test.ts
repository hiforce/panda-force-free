import { expect, test } from "bun:test";
import { ActiveRunBudget, type RunBudgetClock } from "../../src/server/engines/active-budget.js";
import { CreationRunSlots } from "../../src/server/creation/runtime/slots.js";

function clock() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  return {
    port: {
      now: () => now,
      schedule(run, delay) {
        const timer = { at: now + delay, run };
        timers.add(timer);
        return () => timers.delete(timer);
      },
    } satisfies RunBudgetClock,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.run();
      }
      now = end;
    },
  };
}
test("questions suspend the remaining active-time budget; nested holds, duplicate release and close cannot reset it", () => {
  const time = clock();
  let exhausted = 0;
  const budget = new ActiveRunBudget(1000, () => exhausted++, time.port);
  time.advance(400);
  const first = budget.hold(),
    second = budget.hold();
  time.advance(50000);
  first();
  first();
  time.advance(50000);
  expect(exhausted).toBe(0);
  second();
  time.advance(599);
  expect(exhausted).toBe(0);
  time.advance(1);
  expect(exhausted).toBe(1);
  second();
  budget.close();
  time.advance(50000);
  expect(exhausted).toBe(1);
  const closed = new ActiveRunBudget(500, () => exhausted++, time.port),
    resume = closed.hold();
  closed.close();
  resume();
  time.advance(50000);
  expect(exhausted).toBe(1);
});
test("waiting questions release capacity and answered runs reacquire it fairly without exceeding the limit", async () => {
  const slots = new CreationRunSlots(1),
    first = slots.reserve()!,
    signal = new AbortController().signal;
  expect(slots.reserve()).toBeNull();
  first.suspend();
  const second = slots.reserve()!;
  let resumed = false;
  const waiting = first.resume(signal).then(() => {
    resumed = true;
  });
  await Promise.resolve();
  expect(resumed).toBe(false);
  expect(slots.reserve()).toBeNull();
  second.close();
  await waiting;
  expect(resumed).toBe(true);
  expect(slots.reserve()).toBeNull();
  first.suspend();
  await first.resume(signal);
  first.suspend();
  await first.resume(signal);
  expect(slots.reserve()).toBeNull();
  first.close();
  first.close();
  expect(slots.available).toBe(true);
});
test("cancelled or closed waiters neither leak capacity nor acquire a slot after cancellation", async () => {
  const slots = new CreationRunSlots(1),
    first = slots.reserve()!,
    controller = new AbortController();
  first.suspend();
  const second = slots.reserve()!;
  const waiting = first.resume(controller.signal).catch((error) => error);
  controller.abort(new Error("Stopped"));
  expect((await waiting).message).toBe("Stopped");
  first.close();
  second.close();
  expect(slots.available).toBe(true);
  const third = slots.reserve()!;
  third.suspend();
  const fourth = slots.reserve()!;
  const closed = third.resume(new AbortController().signal).catch((error) => error);
  third.close();
  expect((await closed).message).toBe("Creation permit closed");
  fourth.close();
  expect(slots.available).toBe(true);
});
