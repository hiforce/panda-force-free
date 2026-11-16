import { expect, test } from "bun:test";
import { CreationRunner } from "../../src/server/creation/runtime/runner.js";
import type { CreationClaim, CreationScheduling } from "../../src/server/creation/runtime/contracts.js";
import type { CreationWorker } from "../../src/server/creation/runtime/worker.js";
import type { CreationOutputs } from "../../src/server/creation/outputs.js";

test("a creation claim arriving after shutdown is released without starting a worker", async () => {
  let resolveClaim!: (claim: CreationClaim | null) => void,
    entered!: () => void,
    runs = 0,
    releases = 0;
  const claiming = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    pending = new Promise<CreationClaim | null>((resolve) => {
      resolveClaim = resolve;
    }),
    lease = { owner: "owner", taskId: "task", generation: 1, token: "token" };
  const queue: CreationScheduling = {
    claim: async () => {
      entered();
      return pending;
    },
    release: async (value) => {
      expect(value).toEqual(lease);
      releases++;
      return true;
    },
    fail: async () => true,
    nextOutput: async () => null,
  };
  const worker = {
      run: async () => {
        runs++;
      },
    } as unknown as CreationWorker,
    outputs = {
      reconcile: async () => {
        throw Error("unexpected recovery");
      },
    } as unknown as Pick<CreationOutputs, "reconcile">,
    errors: unknown[] = [];
  const runner = new CreationRunner(
    queue,
    worker,
    outputs,
    (_stage, error) => errors.push(error),
    () => 10000,
    1,
  );
  runner.start();
  await claiming;
  const stopped = runner.stop();
  resolveClaim({ lease, task: {} as CreationClaim["task"] });
  await stopped;
  expect(releases).toBe(1);
  expect(runs).toBe(0);
  expect(errors).toEqual([]);
});

test("an asynchronous completion failure records a recoverable output failure after the native artifact is admitted", async () => {
  const { CreationOutputs } = await import("../../src/server/creation/outputs.js");
  let failed = false;
  const task = { spec: {}, artifact: null, outputDigest: "digest", state: "committing" },
    tasks = {
      get: async () => task,
      complete: async () => {
        throw Error("metadata unavailable");
      },
      outputFailure: async () => {
        failed = true;
      },
    } as unknown as import("../../src/server/creation/ports.js").CreationOutputTasks;
  const outputs = new CreationOutputs(
    tasks,
    { stage: async () => "" },
    { commit: async () => ({}) as import("../../src/server/creation/contracts.js").CreationArtifact },
  );
  await expect(outputs.reconcile("owner", "task")).rejects.toThrow("metadata unavailable");
  expect(failed).toBe(true);
});
