import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/** Module mocking runs in its own process so the fake lifecycle cannot affect other Git or ownership suites. */
test("Git completion is subscribed before an already-finished child's output activates close events", async () => {
  const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("../fixtures/project-git-close-order.mjs", import.meta.url))],
      { stdout: "pipe", stderr: "pipe" },
    ),
    [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  expect(error).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(output)).toEqual({ outcome: "completed", result: "observed-result", listenersAtClose: 1 });
});

test("an early close cannot bypass the diagnostic output budget before both streams are activated", async () => {
  const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../fixtures/project-git-close-order.mjs", import.meta.url)),
        "--overflow",
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
    [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  expect(error).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(output)).toEqual({ outcome: "rejected", code: "tooLarge", listenersAtClose: 1 });
});
