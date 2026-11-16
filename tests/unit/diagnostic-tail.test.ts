import { expect, test } from "bun:test";
import { createDiagnosticTail } from "../../src/server/logging/diagnostic-tail.js";

test("the diagnostic tail is byte-bounded and does not split multibyte characters", () => {
  for (const budget of [0, 1, 3, 4, 7, 31, 16384]) {
    const tail = createDiagnosticTail(budget);
    for (const text of ["first", "日志😀".repeat(500), "\nFatal error😀"]) tail.append(text);
    expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(budget);
    expect(tail.text()).not.toContain("�");
    if (budget >= 31) expect(tail.text()).toEndWith("Fatal error😀");
  }
});
