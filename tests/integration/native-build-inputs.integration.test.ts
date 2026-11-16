import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rename, mkdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FileResourceBuildInputs, RESOURCE_INPUT_READ_BYTES } from "../../src/server/builds/resource-inputs.js";
import { SourceRuntime } from "../../src/server/packages/ingestion/runtime.js";
import { resourceBuildFixture } from "../support/resource-build.js";

test("frozen native inputs are binary files beyond legacy JSON quotas and reopen without holding resource allocations", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-native-inputs-")),
    budget = new SourceRuntime(),
    fixture = await resourceBuildFixture({ "large.bin": new Uint8Array(8 * 1024 * 1024 + 1).fill(17) }),
    id = randomUUID();
  try {
    let files = new FileResourceBuildInputs(root, budget);
    files.prepare(id);
    const bytes = await files.write(id, fixture.request);
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(await readdir(join(root, id))).toEqual([fixture.request.digest + ".build"]);
    expect((await readFile(join(root, id, fixture.request.digest + ".build"))).subarray(0, 8).toString()).toBe(
      "PFBLD02\n",
    );
    files = new FileResourceBuildInputs(root, budget);
    await files.with(id, fixture.request.digest, async (restored, size) => {
      expect(restored.digest).toBe(fixture.request.digest);
      expect(restored.tree.read("large.bin")).toEqual(fixture.request.tree.read("large.bin"));
      expect(size).toBe(bytes);
      expect(budget.snapshot().bytes).toBe(RESOURCE_INPUT_READ_BYTES);
    });
    expect(budget.snapshot()).toEqual({ active: 0, bytes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("input removal drains active readers, rejects late writes and never recreates a deleted namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-native-input-drain-")),
    budget = new SourceRuntime(),
    files = new FileResourceBuildInputs(root, budget),
    { request } = await resourceBuildFixture(),
    id = randomUUID();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    files.prepare(id);
    await files.write(id, request);
    const reader = files
      .with(id, request.digest, async () => {
        enter();
        await gate;
        throw Error("callback failed");
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await entered;
    let removed = false;
    const removal = files.remove(id).then(() => {
      removed = true;
    });
    await expect(files.write(id, request)).rejects.toThrow("snapshotUnavailable");
    await expect(files.with(id, request.digest, async () => {})).rejects.toThrow("snapshotUnavailable");
    expect(removed).toBe(false);
    release();
    expect(await reader).toMatchObject({ message: "callback failed" });
    await removal;
    await expect(access(join(root, id))).rejects.toThrow();
    await expect(files.write(id, request)).rejects.toThrow("snapshotUnavailable");
    await expect(access(join(root, id))).rejects.toThrow();
    expect(budget.snapshot()).toEqual({ active: 0, bytes: 0 });
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt files, symlinked namespaces and replaced roots cannot be used as native input", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-native-input-identity-")),
    budget = new SourceRuntime(),
    files = new FileResourceBuildInputs(join(root, "inputs"), budget),
    { request } = await resourceBuildFixture(),
    id = randomUUID(),
    target = join(root, "inputs", id);
  try {
    files.prepare(id);
    await files.write(id, request);
    const path = join(target, request.digest + ".build"),
      bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, bytes.length - 1));
    await expect(files.with(id, request.digest, async () => {})).rejects.toThrow("snapshotUnavailable");
    await rm(target, { recursive: true });
    await symlink(root, target);
    await expect(files.with(id, request.digest, async () => {})).rejects.toThrow("snapshotUnavailable");
    await rename(join(root, "inputs"), join(root, "old-inputs"));
    await mkdir(join(root, "inputs"));
    await expect(files.with(id, request.digest, async () => {})).rejects.toThrow("snapshotUnavailable");
    expect(() => files.prepare(randomUUID())).toThrow("snapshotUnavailable");
    expect(budget.snapshot()).toEqual({ active: 0, bytes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime pressure delays input reads without exposing bytes or leaking a lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-native-input-budget-")),
    budget = new SourceRuntime({ bytes: RESOURCE_INPUT_READ_BYTES, parallel: 1 }),
    files = new FileResourceBuildInputs(root, budget),
    { request } = await resourceBuildFixture(),
    id = randomUUID();
  try {
    files.prepare(id);
    await files.write(id, request);
    const lease = budget.acquire(1)!;
    await expect(
      files.with(id, request.digest, async () => {
        throw Error("unexpected read");
      }),
    ).rejects.toThrow("inputBusy");
    lease.release();
    await files.with(id, request.digest, async () => {});
    expect(budget.snapshot()).toEqual({ active: 0, bytes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
