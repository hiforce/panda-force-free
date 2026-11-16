import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { nativeProjectBuildFixture } from "../support/native-project-build-fixture.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import { resourceBuildBase } from "../support/resource-build.js";
import type { SiteBuild, SiteBuildRequest } from "../../src/shared/builds/jobs.js";

test("project input recovery reuses durable bytes and retains interrupted admission capacity until the original grace period expires", async () => {
  const t = await nativeProjectBuildFixture();
  try {
    await t.place();
    const theme = await t.install();
    t.executor.faults.statusUnavailable = true;
    const command = t.request(theme),
      job = (await t.f.call("/api/site-builds", "POST", command)).body.build as SiteBuild;
    t.db.query("UPDATE site_build_resource_inputs SET ready=0 WHERE id=?").run(job.id);
    await t.restart();
    await t.service.recover();
    const jobs = new SiteBuildRepository(t.db);
    expect(jobs.resources.reservation(job.id).ready).toBe(true);
    expect(jobs.get(job.id).inputHash).toBe(job.inputHash);
    expect(t.executor.inputs.size).toBe(0);
    t.db.query("UPDATE site_build_resource_inputs SET ready=0 WHERE id=?").run(job.id);
    await rm(join(t.root, "data/site-build-inputs", job.id), { recursive: true, force: true });
    await t.service.recover();
    expect(jobs.get(job.id).phase).toBe("queued");
    expect(jobs.resources.reservation(job.id).reservedBytes).toBeGreaterThan(0);
    expect((await t.f.call("/api/site-builds", "POST", command)).status).toBe(429);
    t.db
      .query("UPDATE site_builds SET record=? WHERE id=?")
      .run(JSON.stringify({ ...jobs.get(job.id), createdAt: Date.now() - 180001 }), job.id);
    await t.service.recover();
    expect(jobs.get(job.id)).toMatchObject({ phase: "failed", error: "snapshotUnavailable" });
    expect(jobs.resources.reservation(job.id).reservedBytes).toBe(0);
    const replay = await t.f.call("/api/site-builds", "POST", command);
    expect(replay.status).toBe(202);
    expect(replay.body.build.phase).toBe("failed");
    expect(t.executor.inputs.size).toBe(0);
  } finally {
    await t.close();
  }
}, 30000);

test("schema three retains old JSON build identity and payloads while adding independent resource admission records", () => {
  const db = new Database(":memory:");
  try {
    let jobs = new SiteBuildRepository(db);
    const input = resourceBuildBase(),
      request: SiteBuildRequest = { id: randomUUID(), spaceId: randomUUID(), engine: input.engine, ...input.site },
      job = jobs.create(request, input, [
        { id: "a", path: "intro.md", revisionId: "saved-1", contentHash: "a".repeat(64) },
      ]);
    db.exec(
      "DROP TABLE site_build_resource_inputs; ALTER TABLE site_builds DROP COLUMN removed; UPDATE site_build_schema SET version=2 WHERE id=1;",
    );
    jobs = new SiteBuildRepository(db);
    expect(db.query("SELECT version FROM site_build_schema WHERE id=1").get()).toEqual({ version: 3 });
    expect(jobs.get(job.id)).toEqual(job);
    expect(jobs.existing(request)).toEqual(job);
    expect(jobs.input(job.id)).toEqual(input);
    expect(db.query("SELECT count(*) AS total FROM site_build_resource_inputs").get()).toEqual({ total: 0 });
    expect(jobs.active()).toEqual([job]);
  } finally {
    db.close();
  }
});
