import { expect, test } from "bun:test";
import { SettingsPageLifetime } from "../../src/client/settings-pages/lifetime.js";

test("leaving a settings mount aborts reads and timers while a remount has an independent signal", async () => {
  const page = new SettingsPageLifetime(),
    prior = page.signal,
    epoch = page.epoch;
  let stale = 0,
    current = 0;
  page.timeout(() => stale++, 5);
  page.interval(() => stale++, 5);
  page.invalidate();
  expect(prior.aborted).toBe(true);
  expect(page.epoch).not.toBe(epoch);
  page.renew();
  expect(page.signal).not.toBe(prior);
  expect(page.signal.aborted).toBe(false);
  page.timeout(() => current++, 5);
  await Bun.sleep(25);
  expect(stale).toBe(0);
  expect(current).toBe(1);
  page.invalidate();
});
