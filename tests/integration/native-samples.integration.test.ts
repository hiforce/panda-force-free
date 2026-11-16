import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, access, writeFile } from "node:fs/promises";
import { nativeSampleFixture } from "../support/native-sample-fixture.js";
import { nativeSampleRequest } from "../../src/server/builds/native/commands.js";

test("native sample commands cannot select images, paths, identities or alter the reviewed theme version", () => {
  const request = { id: randomUUID(), theme: { id: "example.native", version: "1.0.0", digest: "a".repeat(64) } };
  expect(nativeSampleRequest(request)).toEqual(request);
  for (const changed of [
    { ...request, actor: "other" },
    { ...request, image: "unreviewed/worker" },
    { ...request, path: "/private" },
    { ...request, theme: { ...request.theme, root: "/private" } },
    { ...request, theme: { ...request.theme, digest: "latest" } },
  ])
    expect(() => nativeSampleRequest(changed)).toThrow("invalidInput");
});

test("native sample inputs live in owned binary files and recover admission, execution, logs and artifacts after reopening", async () => {
  const f = await nativeSampleFixture();
  try {
    const theme = await f.install(),
      request = { id: randomUUID(), theme },
      [job, duplicate] = await Promise.all([f.samples.start("owner", request), f.samples.start("owner", request)]);
    expect(duplicate).toEqual(job);
    const inputPath = join(f.root, "inputs", job.id, job.inputHash + ".build");
    expect((await readFile(inputPath)).subarray(0, 8).toString()).toBe("PFBLD02\n");
    expect(JSON.stringify(f.db.query("SELECT * FROM native_sample_runs").all())).not.toContain("<%= page.title %>");
    expect(f.executor.starts).toBe(0);
    // Simulate process loss after the durable file write but before accepting its reservation.
    f.db.query("UPDATE native_sample_runs SET inputReady=0 WHERE id=?").run(job.id);
    await f.restart();
    expect(f.jobs.active()).toEqual([]);
    expect((await f.samples.lookup("owner", theme))!.id).toBe(job.id);
    await f.samples.recover();
    expect(f.jobs.active().map((value) => value.id)).toEqual([job.id]);
    expect((await f.samples.start("owner", request)).id).toBe(job.id);
    const monitor = f.monitor();
    await monitor.tick();
    expect(f.jobs.get(job.id).phase).toBe("running");
    expect(f.executor.resourceInputs.get(job.id)).toMatchObject({
      digest: job.inputHash,
      paths: ["layout/index.ejs", "source/logo.bin"],
      logo: new Uint8Array([0, 10, 255]),
    });
    expect(f.executor.resourceInputs.get(job.id)!.content).toContain("Good writing makes complex ideas");
    f.executor.complete(job.id);
    await monitor.tick();
    expect(f.samples.requireArtifact("owner", job.id)).toMatchObject({ phase: "completed", artifactAvailable: true });
    expect(f.samples.logs("owner", job.id)).toBe("A fixed sample build log");
    await f.samples.recover();
    await expect(access(inputPath)).rejects.toThrow();
    expect(f.jobs.reservation(job.id).reservedBytes).toBe(0);
    await f.restart();
    expect(f.samples.detail("owner", job.id).artifactAvailable).toBe(true);
    expect((await f.artifacts.read(job.id)).files.map((file) => file.path)).toContain("index.html");
    expect(f.executor.starts).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("accepted native execution survives a lost response, removed local input and disabled theme without a second execution", async () => {
  const f = await nativeSampleFixture();
  try {
    const theme = await f.install(),
      request = { id: randomUUID(), theme },
      job = await f.samples.start("owner", request);
    f.executor.loseResponse = true;
    await f.monitor().tick();
    expect(f.jobs.get(job.id)).toMatchObject({ phase: "queued", connection: "retrying" });
    expect(f.executor.starts).toBe(1);
    f.disable(theme);
    await f.files.remove(job.id);
    await f.restart();
    const monitor = f.monitor();
    await monitor.tick();
    expect(f.jobs.get(job.id).phase).toBe("running");
    f.executor.complete(job.id);
    await monitor.tick();
    expect(f.samples.requireArtifact("owner", job.id).phase).toBe("completed");
    expect((await f.samples.start("owner", request)).id).toBe(job.id);
    await expect(f.samples.start("owner", { id: randomUUID(), theme })).rejects.toThrow("themeNotApproved");
    expect(f.executor.starts).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("new native dispatch rechecks authority and cancellation or corruption becomes a durable terminal receipt", async () => {
  const f = await nativeSampleFixture();
  try {
    const theme = await f.install(),
      first = { id: randomUUID(), theme },
      cancelled = await f.samples.start("owner", first),
      corrupt = await f.samples.start("owner", { id: randomUUID(), theme }),
      revoked = await f.samples.start("owner", { id: randomUUID(), theme });
    expect(f.samples.list("other")).toEqual([]);
    expect(() => f.samples.detail("other", cancelled.id)).toThrow("notFound");
    expect(() => f.samples.cancel("other", cancelled.id)).toThrow("notFound");
    await expect(f.samples.start("other", first)).rejects.toThrow("notFound");
    await expect(f.samples.start("owner", { ...first, theme: { ...theme, digest: "b".repeat(64) } })).rejects.toThrow(
      "idempotencyConflict",
    );
    f.samples.cancel("owner", cancelled.id);
    await writeFile(join(f.root, "inputs", corrupt.id, corrupt.inputHash + ".build"), "corrupt");
    f.disable(theme);
    await f.monitor().tick();
    expect(f.jobs.get(cancelled.id).phase).toBe("cancelled");
    expect(f.jobs.get(corrupt.id)).toMatchObject({ phase: "failed", error: "snapshotUnavailable" });
    expect(f.jobs.get(revoked.id)).toMatchObject({ phase: "failed", error: "themeNotApproved" });
    expect(f.executor.starts).toBe(0);
    await f.samples.recover();
    expect(f.jobs.cleanup()).toEqual([]);
    await f.samples.remove("owner", cancelled.id);
    expect(() => f.samples.detail("owner", cancelled.id)).toThrow("notFound");
    expect((await f.samples.start("owner", first)).phase).toBe("cancelled");
    expect(f.executor.starts).toBe(0);
  } finally {
    await f.dispose();
  }
});

test("cancel before input write completion drains the writer without reviving the task or releasing capacity early", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    f = await nativeSampleFixture({
      files: (files) => ({
        prepare: (id) => files.prepare(id),
        with: (id, digest, read) => files.with(id, digest, read),
        remove: (id) => files.remove(id),
        async write(id, input) {
          const result = files.write(id, input);
          await result;
          enter();
          await gate;
          return result;
        },
      }),
    });
  try {
    const theme = await f.install(),
      request = { id: randomUUID(), theme },
      pending = f.samples.start("owner", request);
    await entered;
    expect(f.jobs.active()).toEqual([]);
    expect(f.samples.cancel("owner", request.id).phase).toBe("cancelled");
    expect(f.jobs.reservation(request.id).reservedBytes).toBeGreaterThan(0);
    let closed = false;
    const closing = f.samples.close().then(() => {
      closed = true;
    });
    await Bun.sleep(1);
    expect(closed).toBe(false);
    release();
    expect((await pending).phase).toBe("cancelled");
    await closing;
    await f.restart();
    await f.samples.recover();
    expect(f.jobs.reservation(request.id).reservedBytes).toBe(0);
    expect(f.executor.starts).toBe(0);
    await expect(access(join(f.root, "inputs", request.id))).rejects.toThrow();
  } finally {
    release();
    await f.dispose();
  }
});

test("preparing native inputs retain bounded capacity across restart and only expire after the recovery grace period", async () => {
  const f = await nativeSampleFixture();
  try {
    const theme = await f.install(),
      jobs = [];
    for (let i = 0; i < 4; i++) jobs.push(await f.samples.start("owner", { id: randomUUID(), theme }));
    await expect(f.samples.start("owner", { id: randomUUID(), theme })).rejects.toThrow("busy");
    const interrupted = jobs[0]!;
    f.db.query("UPDATE native_sample_runs SET inputReady=0 WHERE id=?").run(interrupted.id);
    await f.files.remove(interrupted.id);
    await f.restart();
    await f.samples.recover();
    expect(f.jobs.get(interrupted.id).phase).toBe("queued");
    expect(f.jobs.reservation(interrupted.id).reservedBytes).toBeGreaterThan(0);
    f.advance(180001);
    await f.samples.recover();
    expect(f.jobs.get(interrupted.id)).toMatchObject({ phase: "failed", error: "snapshotUnavailable" });
    expect(f.jobs.reservation(interrupted.id).reservedBytes).toBe(0);
    expect(f.executor.starts).toBe(0);
  } finally {
    await f.dispose();
  }
});
