import { expect, test } from "bun:test";
import { SourceStageOperations } from "../../src/server/packages/staging/operations.js";

test("staging shutdown rejects new admissions and waits for every admitted operation, including failures", async () => {
  const operations = new SourceStageOperations();
  let finish!: (value: string) => void, fail!: (reason: Error) => void;
  const first = operations.run(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
    second = operations.run(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    ),
    failed = second.catch((error: unknown) => error);
  let closed = false;
  const closing = operations.drain().then(() => {
    closed = true;
  });
  await expect(operations.run(async () => "Must not run")).rejects.toThrow("stageUnavailable");
  finish("Finished");
  expect(await first).toBe("Finished");
  expect(closed).toBe(false);
  fail(new Error("Expected failure"));
  const failure = await failed;
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "Expected failure");
  await closing;
  expect(closed).toBe(true);
  await operations.drain();
});
