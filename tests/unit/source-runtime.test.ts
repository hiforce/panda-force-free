import { expect, test } from "bun:test";
import { SourceRuntime } from "../../src/server/packages/ingestion/runtime.js";

test("source runtime admission enforces byte and concurrency budgets and releases each allocation once", () => {
  const runtime = new SourceRuntime({ bytes: 100, parallel: 2 }),
    first = runtime.acquire(60);
  expect(first).not.toBeNull();
  expect(runtime.acquire(41)).toBeNull();
  const second = runtime.acquire(40);
  expect(second).not.toBeNull();
  expect(runtime.snapshot()).toEqual({ active: 2, bytes: 100 });
  first!.release();
  first!.release();
  expect(runtime.snapshot()).toEqual({ active: 1, bytes: 40 });
  const third = runtime.acquire(1);
  expect(third).not.toBeNull();
  expect(runtime.acquire(1)).toBeNull();
  expect(() => runtime.acquire(101)).toThrow("sourceTooLarge");
  expect(() => runtime.acquire(Number.NaN)).toThrow("invalidSource");
  second!.release();
  third!.release();
  expect(runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
});
