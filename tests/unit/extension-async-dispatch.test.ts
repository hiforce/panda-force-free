import { test, expect } from "bun:test";
import { legacyBuildRunDispatcher } from "../../src/server/builds/runtime/legacy-dispatch.js";
import { resourceBuildDispatcher } from "../../src/server/builds/resource-dispatch.js";
import { resourceBuildFixture } from "../support/resource-build.js";
import { SiteBuildError } from "../../src/server/builds/errors.js";
import type { BuildRun } from "../../src/shared/builds/run.js";
import type { SiteExecutor } from "../../src/server/builds/executor-port.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const job: BuildRun = {
  id: "fixture",
  engine: "hexo",
  inputHash: "a".repeat(64),
  phase: "queued",
  createdAt: 1,
  updatedAt: 1,
  error: null,
  connection: "ready",
  outputBytes: 0,
  fileCount: 0,
  artifactAvailable: false,
  image: null,
};
function executor() {
  let starts = 0,
    cancels = 0;
  const remote: SiteExecutor = {
    availability: async () => ({ state: "ready", engines: {} }),
    status: async () => {
      throw new SiteBuildError("executorMissing", 404);
    },
    start: async () => {
      starts++;
      return { id: job.id, engine: job.engine, inputHash: job.inputHash, phase: "running", createdAt: 1, updatedAt: 1 };
    },
    startResource: async () => {
      starts++;
      return { id: job.id, engine: job.engine, inputHash: job.inputHash, phase: "running", createdAt: 1, updatedAt: 1 };
    },
    cancel: async () => {
      cancels++;
      return {
        id: job.id,
        engine: job.engine,
        inputHash: job.inputHash,
        phase: "failed",
        error: "cancelled",
        createdAt: 1,
        updatedAt: 1,
      };
    },
    logs: async () => "",
    result: async () => ({ protocol: 1, files: [], bytes: 0 }),
  };
  return {
    remote,
    get starts() {
      return starts;
    },
    get cancels() {
      return cancels;
    },
  };
}

test("legacy dispatch observes cancellation accepted while an asynchronous grant is pending", async () => {
  const fixture = await resourceBuildFixture(),
    remote = executor(),
    entered = deferred(),
    released = deferred();
  let current = { ...job };
  const dispatch = legacyBuildRunDispatcher({ input: async () => fixture.input }, remote.remote, async () => {
    entered.resolve();
    await released.promise;
  });
  const pending = dispatch.start(job, { closed: () => false, current: async () => current });
  await entered.promise;
  current = { ...current, phase: "cancelling" };
  released.resolve();
  await pending;
  expect(remote.starts).toBe(0);
  expect(remote.cancels).toBe(1);
});

test("resource dispatch rechecks persisted cancellation after asynchronous source and theme authorization", async () => {
  const fixture = await resourceBuildFixture(),
    remote = executor(),
    entered = deferred(),
    released = deferred();
  let current = { ...job, inputHash: fixture.request.digest };
  const dispatch = resourceBuildDispatcher(
    async () => ({
      actor: "owner",
      theme: { id: fixture.theme.id, version: fixture.theme.version, digest: "b".repeat(64) },
    }),
    {
      prepare: () => {},
      write: async () => 32,
      remove: async () => {},
      with: async (_id, _digest, read) => read(fixture.request, 32),
    },
    {
      describe: async () => ({ engine: "hexo" }),
      authorize: async () => {
        entered.resolve();
        await released.promise;
      },
      with: async () => {
        throw Error("Dispatcher must use the frozen input");
      },
    },
    remote.remote,
  );
  const pending = dispatch.start(current, { closed: () => false, current: async () => current });
  await entered.promise;
  current = { ...current, phase: "cancelled" };
  released.resolve();
  await pending;
  expect(remote.starts).toBe(0);
  expect(remote.cancels).toBe(1);
});
