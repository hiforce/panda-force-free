import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { BuildInput, BuildExecution, BuildArtifact } from "../../src/shared/builds/contracts.js";
import { terminalBuildRun, type BuildRun } from "../../src/shared/builds/run.js";
import type { BuildRunStore, LegacyBuildRunInputs } from "../../src/server/builds/runtime/ports.js";
import { legacyBuildRunDispatcher } from "../../src/server/builds/runtime/legacy-dispatch.js";
import { BuildRunReconciler } from "../../src/server/builds/runtime/reconciler.js";
import { SiteBuildError } from "../../src/server/builds/errors.js";
import { freezeTrustedBuildTheme } from "../../src/shared/builds/trusted-theme.js";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { profileThemePackage } from "../support/profile-theme-package.js";
import { freezePackageProfile } from "../../src/shared/builds/profile-theme.js";
import type { BuildThemeSnapshot } from "../../src/shared/builds/theme.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(theme?: BuildThemeSnapshot) {
  const input: BuildInput = {
    protocol: 1,
    engine: "hexo",
    preset: "reader",
    site: { title: "Template sample", url: "https://example.test", basePath: "/", locale: "en" },
    documents: [{ id: "sample", path: "sample.md", title: "Sample", content: "A fixed sample." }],
    assets: [],
    ...(theme ? { theme } : {}),
  };
  let now = 1000;
  let row: BuildRun & { fixtureId: string } = {
    id: randomUUID(),
    fixtureId: "core",
    engine: "hexo",
    inputHash: hash(JSON.stringify(input)),
    phase: "queued",
    createdAt: now,
    updatedAt: now,
    error: null,
    connection: "ready",
    outputBytes: 0,
    fileCount: 0,
    artifactAvailable: false,
    image: null,
  };
  const controls = {
    loseAcknowledgement: false,
    offline: false,
    denied: false,
    statusHook: null as (() => Promise<void>) | null,
  };
  const calls = { starts: 0, status: 0, cancel: 0, authorize: 0, collections: 0, stops: 0 };
  let remote: BuildExecution | null = null;
  const logs: string[] = [],
    budgets: number[] = [],
    events: object[] = [];
  const store: BuildRunStore & LegacyBuildRunInputs = {
    active: () => (terminalBuildRun(row) ? [] : [structuredClone(row)]),
    get: () => structuredClone(row),
    input: () => structuredClone(input),
    update(_id, changes) {
      row = { ...row, ...changes, updatedAt: now };
      return structuredClone(row);
    },
    saveLogs(_id, value) {
      logs.push(value);
    },
  };
  const output: BuildArtifact = {
    protocol: 1,
    bytes: 1,
    files: [{ path: "index.html", data: Buffer.from("A").toString("base64"), sha256: hash("A") }],
  };
  const executor = {
    availability: async () => ({ state: "ready" as const, engines: { hexo: "8.1.1" } }),
    async start() {
      calls.starts++;
      if (controls.offline) throw new SiteBuildError("executorUnavailable", 503);
      remote = {
        id: row.id,
        inputHash: row.inputHash,
        engine: row.engine,
        phase: "running",
        createdAt: now,
        updatedAt: now,
      };
      if (controls.loseAcknowledgement) {
        controls.loseAcknowledgement = false;
        throw new SiteBuildError("executorUnavailable", 503);
      }
      return structuredClone(remote);
    },
    async status() {
      calls.status++;
      await controls.statusHook?.();
      if (!remote) throw new SiteBuildError("executorMissing", 404);
      return structuredClone(remote);
    },
    async cancel() {
      calls.cancel++;
      if (!remote) throw new SiteBuildError("executorMissing", 404);
      remote = { ...remote, phase: "failed", error: "cancelled" };
      return structuredClone(remote);
    },
    logs: async () => "Sample execution log",
    result: async () => output,
  };
  const monitor = () =>
    new BuildRunReconciler(
      store,
      {
        async put(_id, value) {
          calls.collections++;
          return value;
        },
      },
      executor,
      (event) => events.push(event),
      {
        async prune(bytes) {
          budgets.push(bytes || 0);
        },
        stop() {
          calls.stops++;
        },
      },
      legacyBuildRunDispatcher(store, executor, () => {
        calls.authorize++;
        if (controls.denied) throw new SiteBuildError("themeNotApproved", 403);
      }),
      "template-fixture",
      () => now,
    );
  return {
    store,
    controls,
    calls,
    logs,
    budgets,
    events,
    monitor,
    row: () => structuredClone(row),
    remote: (changes: Partial<BuildExecution>) => {
      if (!remote) throw Error("No accepted execution");
      remote = { ...remote, ...changes };
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("the shared monitor completes caller-owned sample records without a document space", async () => {
  const f = await fixture(),
    monitor = f.monitor();
  try {
    await monitor.tick();
    expect(f.row().phase).toBe("running");
    f.remote({ phase: "completed" });
    await monitor.tick();
    expect(f.row()).toMatchObject({
      fixtureId: "core",
      phase: "completed",
      artifactAvailable: true,
      outputBytes: 1,
      fileCount: 1,
    });
    expect(f.row()).not.toHaveProperty("spaceId");
    expect(f.calls).toMatchObject({ starts: 1, collections: 1, authorize: 1 });
    expect(f.budgets[0]).toBeGreaterThan(1);
    expect(f.logs).toEqual(["Sample execution log", "Sample execution log"]);
    expect(f.events).toContainEqual({ event: "template-fixture.completed", id: f.row().id, files: 1, bytes: 1 });
  } finally {
    monitor.stop();
  }
});

for (const mode of ["code", "profile"] as const) {
  test(`a restarted sample monitor observes accepted ${mode} work before rechecking a revoked grant`, async () => {
    const theme =
      mode === "code"
        ? await freezeTrustedBuildTheme(exampleThemePackage(), "journal")
        : await freezePackageProfile(profileThemePackage(), "journal");
    const f = await fixture(theme),
      initial = f.monitor();
    f.controls.loseAcknowledgement = true;
    try {
      await initial.tick();
      expect(f.row()).toMatchObject({ phase: "queued", connection: "retrying" });
    } finally {
      initial.stop();
    }
    f.controls.denied = true;
    const resumed = f.monitor();
    try {
      await resumed.tick();
      expect(f.row()).toMatchObject({ phase: "running", connection: "ready", error: null });
      f.remote({ phase: "completed" });
      await resumed.tick();
      expect(f.row().phase).toBe("completed");
      expect(f.calls).toMatchObject({ starts: 1, authorize: 1, collections: 1 });
    } finally {
      resumed.stop();
    }
  });
}

for (const mode of ["code", "profile"] as const) {
  test(`a revoked ${mode} grant cannot dispatch a missing remote sample`, async () => {
    const theme =
      mode === "code"
        ? await freezeTrustedBuildTheme(exampleThemePackage(), "journal")
        : await freezePackageProfile(profileThemePackage(), "journal");
    const f = await fixture(theme),
      monitor = f.monitor();
    f.controls.denied = true;
    try {
      await monitor.tick();
      expect(f.row()).toMatchObject({ phase: "failed", error: "themeNotApproved" });
      expect(f.calls).toMatchObject({ starts: 0, status: 1, authorize: 1, collections: 0 });
    } finally {
      monitor.stop();
    }
  });
}

test("a sample cancellation bypasses retry backoff and never dispatches missing work", async () => {
  const f = await fixture(),
    monitor = f.monitor();
  f.controls.offline = true;
  try {
    await monitor.tick();
    f.advance(1);
    await monitor.tick();
    expect(f.calls.starts).toBe(1);
    f.store.update(f.row().id, { phase: "cancelling" });
    await monitor.tick();
    expect(f.row().phase).toBe("cancelled");
    await monitor.tick();
    expect(f.calls).toMatchObject({ starts: 1, cancel: 1, collections: 0 });
  } finally {
    monitor.stop();
  }
});

test("shutdown during an ownership-independent status read cannot authorize or dispatch another sample", async () => {
  const f = await fixture(await freezeTrustedBuildTheme(exampleThemePackage(), "journal")),
    monitor = f.monitor();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.controls.statusHook = async () => {
    entered();
    await gate;
  };
  const pending = monitor.tick();
  await started;
  monitor.stop();
  release();
  await pending;
  expect(f.row().phase).toBe("queued");
  expect(f.calls).toMatchObject({ starts: 0, authorize: 0, collections: 0 });
});

test("a remote identity mismatch fails the sample permanently without collecting another result", async () => {
  const f = await fixture(),
    monitor = f.monitor();
  try {
    await monitor.tick();
    f.remote({ inputHash: "f".repeat(64) });
    await monitor.tick();
    expect(f.row()).toMatchObject({ phase: "failed", error: "executorProtocol" });
    await monitor.tick();
    expect(f.calls).toMatchObject({ starts: 1, collections: 0 });
    expect(f.events).toContainEqual({ event: "template-fixture.failed", id: f.row().id, code: "executorProtocol" });
  } finally {
    monitor.stop();
  }
});
