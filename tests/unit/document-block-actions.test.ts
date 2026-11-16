import { expect, test } from "bun:test";

test("whole-block formats unwrap containers, preserve neighboring source and undo atomically", async () => {
  const child = Bun.spawn([process.execPath, "tests/support/document-block-model.mjs"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(JSON.parse(output)).toEqual({
    cases: 56,
    unsupported: 3,
    textPreserved: true,
    neighborsPreserved: true,
    undo: true,
  });
});
