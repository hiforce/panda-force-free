import { expect, test } from "bun:test";
import { codeHighlightAllowed } from "../../src/client/documents/code-block/limits.js";

test("code display accepts supported boundary sizes and leaves over-budget input for plain display", () => {
  expect(codeHighlightAllowed("")).toBe(true);
  expect(codeHighlightAllowed("a".repeat(8192))).toBe(true);
  expect(codeHighlightAllowed("a".repeat(8193))).toBe(false);
  expect(codeHighlightAllowed(("a".repeat(8191) + "\n").repeat(32))).toBe(true);
  expect(codeHighlightAllowed(("a".repeat(8192) + "\n").repeat(31))).toBe(true);
  expect(codeHighlightAllowed(("a".repeat(8191) + "\n").repeat(32) + "a")).toBe(false);
});
