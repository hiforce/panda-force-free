import { expect, test } from "bun:test";
import { createFeaturePort, installFeature } from "../../src/client/application/composition.js";

test("peer construction is deferred and installed interfaces are immutable", () => {
  const first = createFeaturePort<{ read(): string }>("first");
  const second = createFeaturePort<{ value: string }>("second");
  expect(() => second.value).toThrow("read before installation");
  installFeature(first, { read: () => second.value });
  expect(() => first.read()).toThrow("second");
  installFeature(second, { value: "ready" });
  expect(first.read()).toBe("ready");
  expect(Object.isFrozen(first)).toBe(true);
  expect(() => Object.assign(second, { value: "changed" })).toThrow("read-only");
  expect(() => installFeature(second, { value: "changed" })).toThrow("already installed");
});
