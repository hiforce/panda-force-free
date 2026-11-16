import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { siteSampleRequest } from "../../src/shared/plugins/site-samples.js";
import { definitionSiteSample, siteSampleKey } from "../../src/server/plugins/integration/site-sample-input.js";
import { SqliteSiteSamples } from "../../src/server/plugins/storage/site-samples.js";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { SiteBuildRetention } from "../../src/server/builds/retention.js";
import { siteSampleFixture, siteSampleDefinition } from "../support/site-sample-fixture.js";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";
import { SqliteTemplateLibrary } from "../../src/server/plugins/storage/library.js";
import { PUBLIC_STYLE_SAMPLE } from "../../src/shared/presentation/sample-content.js";

const catalog = { kind: "catalog" as const, engine: "hexo" as const, reference: "panda.reader@1.0.0" };
test("the public site sample leaves its article title to the native layout", () => {
  expect(PUBLIC_STYLE_SAMPLE.title).toBe("A place for clear ideas");
  expect(PUBLIC_STYLE_SAMPLE.content).not.toMatch(/^# A place for clear ideas$/m);
  expect(PUBLIC_STYLE_SAMPLE.content).toContain("##");
});
test("sample requests are closed and cannot choose execution images, credentials, source paths or another owner", () => {
  const id = randomUUID();
  expect(siteSampleRequest({ source: { reference: catalog.reference, kind: "catalog", engine: "hexo" }, id })).toEqual({
    id,
    source: catalog,
  });
  for (const source of [
    { ...catalog, image: "private.invalid/worker" },
    { ...catalog, path: "/root/private.md" },
    { ...catalog, actor: "other" },
    { ...catalog, token: "secret" },
  ])
    expect(() => siteSampleRequest({ id, source })).toThrow();
  expect(() => siteSampleRequest({ id: "01a1aa8e-b40c-7aa0-8bbc-9a832e801186", source: catalog })).toThrow();
  expect(() => siteSampleRequest({ id, source: catalog, image: "ignored" })).toThrow();
});
test("accepting a baseline or editing archive metadata changes the draft identity without invalidating its execution key", async () => {
  const original = siteSampleDefinition(),
    first = await definitionSiteSample(original, "journal"),
    edited = structuredClone(original);
  edited.fixtures[0]!.expectedDigest = "a".repeat(64);
  edited.archive.changelog = "Reviewed output";
  const second = await definitionSiteSample(edited, "journal");
  expect(second.definitionDigest).not.toBe(first.definitionDigest);
  expect(second.input).toEqual(first.input);
  expect(await siteSampleKey(second.input)).toBe(await siteSampleKey(first.input));
  edited.fixtures[0]!.content += "\nA new claim.\n";
  expect(await siteSampleKey((await definitionSiteSample(edited, "journal")).input)).not.toBe(
    await siteSampleKey(first.input),
  );
  expect(first.input).not.toHaveProperty("project");
  expect(first.input.assets).toEqual([]);
  expect(first.input.documents[0]!.content).toBe(original.fixtures[0]!.content);
});
test("durable sample requests are idempotent, owner-scoped and discoverable after reopening storage", async () => {
  const f = await siteSampleFixture();
  try {
    const request = { id: randomUUID(), source: catalog },
      job = await f.samples.start(request, "owner");
    expect(await f.samples.start(request, "owner")).toEqual(job);
    expect(f.samples.list("owner").map((item) => item.id)).toEqual([job.id]);
    expect(f.samples.list("other")).toEqual([]);
    expect(() => f.samples.detail(job.id, "other")).toThrow("sampleNotFound");
    expect(() => f.samples.logs(job.id, "other")).toThrow("sampleNotFound");
    expect(() => f.samples.cancel(job.id, "other")).toThrow("sampleNotFound");
    await expect(f.samples.start(request, "other")).rejects.toThrow("sampleNotFound");
    await expect(
      f.samples.start({ ...request, source: { ...catalog, reference: "panda.journal@1.0.0" } }, "owner"),
    ).rejects.toThrow("sampleConflict");
    const reopened = openPluginDatabase(f.databasePath);
    try {
      const saved = new SqliteSiteSamples(reopened);
      expect(saved.get(job.id)).toEqual(job);
      expect(saved.input(job.id).documents[0]!.content).toContain("Good writing makes complex ideas");
      expect(saved.active()).toHaveLength(1);
    } finally {
      reopened.close();
    }
    expect(f.executor.starts).toBe(0);
  } finally {
    await f.dispose();
  }
});
test("unapproved theme code and unsupported executors never create executable sample work", async () => {
  const f = await siteSampleFixture();
  try {
    const bundle = (await verifyPluginPackage(exampleThemePackage())).package;
    const draft = await f.library.save(siteSampleDefinition(bundle), "owner");
    const source = {
      kind: "draft" as const,
      id: draft.id,
      revision: draft.revision,
      fixtureId: draft.definition.fixtures[0]!.id,
    };
    await expect(f.samples.start({ id: randomUUID(), source }, "owner")).rejects.toThrow("themeNotApproved");
    expect(f.jobs.active()).toEqual([]);
    await f.install(draft.definition.package);
    f.executor.available.trustedThemes = false;
    await expect(f.samples.start({ id: randomUUID(), source }, "owner")).rejects.toThrow(
      "trustedThemeExecutorRequired",
    );
    expect(f.jobs.active()).toEqual([]);
    expect(f.executor.starts).toBe(0);
  } finally {
    await f.dispose();
  }
});
test("collected site artifacts feed the baseline, validation and archive loop for both site engines", async () => {
  const f = await siteSampleFixture();
  try {
    let draft = await f.library.save(siteSampleDefinition(), "owner");
    await f.install(draft.definition.package);
    const monitor = f.monitor();
    for (const fixture of draft.definition.fixtures) {
      const job = await f.samples.start(
        { id: randomUUID(), source: { kind: "draft", id: draft.id, revision: draft.revision, fixtureId: fixture.id } },
        "owner",
      );
      await monitor.tick();
      f.executor.complete(job.id);
      await monitor.tick();
      const preview = await f.library.preview(draft.id, fixture.id);
      expect(preview.state).toBe("unreviewed");
      expect(preview.html).toContain("<style>h1{color:#123456}");
      expect(preview.html).not.toContain("<script");
      expect(preview.html).not.toContain("https://private.invalid");
      expect(preview.siteEvidence).toMatchObject({
        runId: job.id,
        inputHash: job.inputHash,
        engineVersion: job.context.engineVersion,
      });
      expect(preview.sitePages).toEqual(["index.html", "sample/index.html"]);
      expect(f.jobs.get(job.id).phase).toBe("completed");
      expect(() => f.jobs.input(job.id)).toThrow("sampleArtifactUnavailable");
      const starts = f.executor.starts;
      draft = await f.library.acceptBaseline(draft.id, draft.revision, fixture.id, preview.actualDigest!, "owner");
      expect((await f.library.preview(draft.id, fixture.id)).state).toBe("passed");
      expect(f.executor.starts).toBe(starts);
    }
    draft = await f.library.validate(draft.id, draft.revision, "owner");
    expect(draft.validation?.passed).toBe(true);
    expect(draft.validation?.results.every((result) => result.siteEvidence?.runId)).toBe(true);
    const review = await f.registry.review(draft.definition.package);
    const release = await f.library.publish(
      draft.id,
      draft.revision,
      draft.digest,
      { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
      "owner",
    );
    expect(release.validation.passed).toBe(true);
    expect(release.packageDigest).toBe(draft.packageDigest);
    expect(f.executor.starts).toBe(2);
  } finally {
    await f.dispose();
  }
});

test("schema two upgrades retain installed authority and template drafts before adding sample intent storage", async () => {
  const f = await siteSampleFixture();
  try {
    const draft = await f.library.save(siteSampleDefinition(), "owner");
    await f.install(draft.definition.package);
    const registry = f.registry.snapshot();
    f.db.exec(
      "DROP TABLE plugin_export_heads;DROP TABLE plugin_exports;ALTER TABLE plugin_versions DROP COLUMN grants;ALTER TABLE plugin_audit DROP COLUMN exports;DROP TABLE site_sample_runs;PRAGMA user_version=2",
    );
    const upgraded = openPluginDatabase(f.databasePath);
    try {
      expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(new SqliteTemplateLibrary(upgraded).get(draft.id)).toEqual(draft);
      expect(new SqliteSiteSamples(upgraded).list("owner")).toEqual([]);
      expect(f.registry.snapshot()).toEqual(registry);
    } finally {
      upgraded.close();
    }
  } finally {
    await f.dispose();
  }
});
test("accepted work survives a lost response and disabled approval when a new monitor recovers it", async () => {
  const f = await siteSampleFixture();
  try {
    const draft = await f.library.save(siteSampleDefinition(), "owner");
    await f.install(draft.definition.package);
    const source = { kind: "draft" as const, id: draft.id, revision: draft.revision, fixtureId: "journal" };
    const job = await f.samples.start({ id: randomUUID(), source }, "owner"),
      first = f.monitor();
    f.executor.loseResponse = true;
    await first.tick();
    first.stop();
    expect(f.jobs.get(job.id).connection).toBe("retrying");
    const installed = f.registry.snapshot().packages[0]!;
    f.registry.setEnabled(installed.id, installed.version, false, f.registry.snapshot().revision, "owner");
    const resumed = f.monitor();
    await resumed.tick();
    expect(f.jobs.get(job.id).phase).toBe("running");
    expect(f.executor.starts).toBe(1);
    f.executor.complete(job.id);
    await resumed.tick();
    expect(f.jobs.get(job.id).artifactAvailable).toBe(true);
    await expect(f.samples.start({ id: randomUUID(), source }, "owner")).rejects.toThrow("themeNotApproved");
    expect(f.executor.starts).toBe(1);
  } finally {
    await f.dispose();
  }
});
test("cancellation and corrupt captured input reach terminal receipts without dispatching work", async () => {
  const f = await siteSampleFixture();
  try {
    const cancelled = await f.samples.start({ id: randomUUID(), source: catalog }, "owner");
    f.samples.cancel(cancelled.id, "owner");
    const monitor = f.monitor();
    await monitor.tick();
    expect(f.jobs.get(cancelled.id).phase).toBe("cancelled");
    const damaged = await f.samples.start({ id: randomUUID(), source: catalog }, "owner");
    f.db.query("UPDATE site_sample_runs SET input=? WHERE id=?").run("{}", damaged.id);
    await monitor.tick();
    expect(f.jobs.get(damaged.id)).toMatchObject({ phase: "failed", error: "snapshotUnavailable" });
    expect(f.executor.starts).toBe(0);
    await f.samples.remove(cancelled.id, "owner");
    expect(() => f.samples.detail(cancelled.id, "owner")).toThrow("sampleNotFound");
  } finally {
    await f.dispose();
  }
});
test("sample concurrency is bounded and artifact expiry requires an explicit rebuild while preserving the receipt", async () => {
  const f = await siteSampleFixture();
  try {
    const jobs = [];
    for (let index = 0; index < 4; index++)
      jobs.push(await f.samples.start({ id: randomUUID(), source: catalog }, "owner"));
    await expect(f.samples.start({ id: randomUUID(), source: catalog }, "owner")).rejects.toThrow("sampleBusy");
    const monitor = f.monitor();
    await monitor.tick();
    for (const job of jobs) f.executor.complete(job.id);
    await monitor.tick();
    const first = jobs[0]!;
    f.db
      .query("UPDATE site_sample_runs SET record=? WHERE id=?")
      .run(JSON.stringify({ ...f.jobs.get(first.id), createdAt: Date.now() - 15 * 86400000 }), first.id);
    await new SiteBuildRetention(f.jobs, f.artifacts).prune();
    expect(f.jobs.get(first.id)).toMatchObject({ phase: "completed", artifactAvailable: false });
    expect(() => f.samples.requireArtifact(first.id, "owner")).toThrow("sampleArtifactUnavailable");
    expect(f.samples.logs(first.id, "owner")).toBe("A fixed sample build log");
    expect(f.executor.starts).toBe(4);
  } finally {
    await f.dispose();
  }
});
