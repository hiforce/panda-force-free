import { expect, test } from "bun:test";

test("isolated rich surface preserves readable semantics and guards asynchronous editor lifetime", async () => {
  const child = Bun.spawn([process.execPath, "tests/support/document-rich-surface.mjs"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, err).toBe(0);
  expect(JSON.parse(out)).toMatchObject({
    passed: true,
    reader: true,
    draftProjection: true,
    cancellation: true,
    disposal: true,
    focus: true,
    retry: true,
    initializationFencing: true,
  });
});
