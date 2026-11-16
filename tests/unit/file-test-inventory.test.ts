import { expect, test } from "bun:test";
import { fileTestBatches } from "../../scripts/testing/file-tests.mjs";

test("bounded worker batches retain the exact exhaustive inventory once and in order", () => {
  const files = Array.from({ length: 217 }, (_, index) => `tests/unit/case-${index}.test.ts`),
    batches = fileTestBatches(files);
  expect(batches.flat()).toEqual(files);
  expect(new Set(batches.flat()).size).toBe(files.length);
  expect(batches.every((batch) => batch.length > 0 && batch.length <= 24)).toBeTrue();
  expect(() => fileTestBatches([...files, files[0]!])).toThrow("inventory");
  expect(() => fileTestBatches(["tests/unit/../private.test.ts"])).toThrow("inventory");
});
