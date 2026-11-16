import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { nativeProjectBuildFixture } from "../support/native-project-build-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { waitFor } from "../support/app-fixture.mjs";
import { decodeResourceBuild } from "../../src/shared/builds/resource-frame.js";
import { publicationSources } from "../../src/server/delivery/integration/sources.js";
import type { SiteBuild } from "../../src/shared/builds/jobs.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";

test("native project inputs bind saved file revisions, independent image bytes and Git provenance without resolving a legacy theme", async () => {
  const t = await nativeProjectBuildFixture();
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#4a7898" } })
        .png()
        .toBuffer(),
      asset = await t.f.application().assets.upload(t.actor, t.projectId, "doc-1", "diagram.png", randomUUID(), png),
      document = projectDocumentFixture(
        2,
        "doc-1",
        `Frozen native project\n\n![diagram](/api/document-assets/content?id=${asset.id})\n`,
      );
    await t.f.project.documents.put(document, 1, "native-source", t.author);
    await t.place(document.revision.id);
    await t.f.application().editor.autosave(t.actor, t.projectId, "doc-1", {
      operationId: randomUUID(),
      version: 0,
      baseRevisionId: document.revision.id,
      working: { title: "Unsaved", locale: "en", content: "Do not build this working draft", resources: [] },
    });
    const theme = await t.install(),
      request = t.request(theme),
      commit = await t.f.snapshots.head();
    t.executor.faults.statusUnavailable = true;
    const created = await t.f.call("/api/site-builds", "POST", request);
    expect(created.status).toBe(202);
    const job = created.body.build as SiteBuild,
      path = join(t.root, "data/site-build-inputs", job.id, job.inputHash + ".build"),
      frozen = await decodeResourceBuild(new Uint8Array(await readFile(path)));
    expect(job).toMatchObject({
      inputProtocol: 2,
      nativeTheme: theme,
      sourceSnapshot: { projectId: t.projectId, commit, spaceVersion: 2 },
    });
    expect(job.sources[0]!.revisionId).toBe(document.revision.id);
    expect(frozen.descriptor.input.documents[0]!.content).toContain("Frozen native project");
    expect(frozen.descriptor.input.documents[0]!.content).not.toContain("working draft");
    expect(frozen.descriptor.input.theme).toBeUndefined();
    expect(frozen.descriptor.input.assets).toHaveLength(1);
    expect(Buffer.from(frozen.descriptor.input.assets[0]!.data, "base64")).toEqual(png);
    expect(frozen.descriptor.input.assets[0]!.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(frozen.tree.read("source/logo.bin")).toEqual(new Uint8Array([0, 10, 255]));
    expect(
      t.db.query<{ input: string | null }, [string]>("SELECT input FROM site_builds WHERE id=?").get(job.id)!.input,
    ).toBeNull();
    expect(JSON.stringify(t.db.query("SELECT * FROM site_builds").all())).not.toContain("Frozen native project");
    const other = { "x-fixture-owner": "other" };
    expect(
      (
        await t.f.call(
          "/api/site-builds?" + new URLSearchParams({ space: t.space.id, project: t.projectId }),
          "GET",
          undefined,
          other,
        )
      ).body.builds,
    ).toEqual([]);
    expect((await t.f.call("/api/site-builds/detail?id=" + job.id, "GET", undefined, other)).status).toBe(404);
    expect((await t.f.call("/api/site-builds", "POST", request, other)).status).toBe(404);
    expect((await t.f.call("/api/site-builds", "POST", { ...request, actor: "forged" })).status).toBe(400);
    await t.f.project.documents.put(
      projectDocumentFixture(3, "doc-1", "Later saved edit"),
      2,
      "later-source",
      t.author,
    );
    await t.restart();
    const replay = await t.f.call("/api/site-builds", "POST", request);
    expect(replay.status).toBe(202);
    expect(replay.body.build.inputHash).toBe(job.inputHash);
    t.executor.faults.statusUnavailable = false;
    await waitFor(async () => {
      const current = await t.service.detail(job.id, t.actor);
      if (current.phase === "failed") throw Error(current.error!);
      return t.executor.gates.has(job.id);
    });
    expect(t.executor.inputs.get(job.id)!.documents[0]!.content).toContain("Frozen native project");
    expect(t.executor.inputs.get(job.id)!.documents[0]!.content).not.toContain("Later saved edit");
    t.executor.release(job.id);
    await waitFor(async () => (await t.service.detail(job.id, t.actor)).phase === "completed");
    expect((await t.f.call("/api/site-builds/pages?id=" + job.id)).status).toBe(200);
    expect((await t.f.call("/api/site-builds/pages?id=" + job.id, "GET", undefined, other)).status).toBe(404);
    const preview = await t.f.raw(`/api/site-builds/preview/${job.id}/index.html`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(await preview.text()).not.toContain("<script");
    expect((await t.f.raw("/api/site-builds/download?id=" + job.id, "GET", undefined, other)).status).toBe(404);
    const publication = publicationSources(
      t.service,
      {
        spaces: {
          get() {
            throw Error("Legacy source must not be read");
          },
        },
        listSpaces() {
          throw Error("Legacy source must not be read");
        },
      },
      {
        spaces: t.f.application().spaces,
        requireProject: (id) => {
          if (!t.f.grants.has(id)) throw Error("Missing project");
        },
      },
    );
    await expect(publication.capture(job.id, "other")).rejects.toThrow("notFound");
    const planSource = await publication.capture(job.id, t.actor);
    expect(planSource.build.inputHash).toBe(job.inputHash);
    expect(planSource.build.sourceSnapshot).toMatchObject({ projectId: t.projectId, commit });
    expect(planSource.sourceProjectId).toBe(t.projectId);
    expect(t.legacyCaptures).toBe(0);
    await t.service.recover();
    await expect(access(path)).rejects.toThrow();
    expect((await t.f.call("/api/site-builds/detail?id=" + job.id, "DELETE")).status).toBe(200);
    expect((await t.f.call("/api/site-builds/detail?id=" + job.id)).status).toBe(404);
    const removedReplay = await t.f.call("/api/site-builds", "POST", request);
    expect(removedReplay.status).toBe(202);
    expect(removedReplay.body.build.artifactAvailable).toBe(false);
    expect(t.executor.inputs.size).toBe(1);
  } finally {
    await t.close();
  }
}, 30000);

test("revoked project access prevents fresh native dispatch while cleanup remains independent of that namespace", async () => {
  const t = await nativeProjectBuildFixture();
  try {
    await t.place();
    const theme = await t.install();
    t.executor.faults.statusUnavailable = true;
    const job = (await t.f.call("/api/site-builds", "POST", t.request(theme))).body.build as SiteBuild;
    t.f.grants.delete(t.projectId);
    await t.restart();
    t.executor.faults.statusUnavailable = false;
    const jobs = new SiteBuildRepository(t.db);
    await waitFor(() => jobs.get(job.id).phase === "failed");
    expect(jobs.get(job.id).error).toBe("snapshotUnavailable");
    expect(t.executor.inputs.size).toBe(0);
    await t.service.recover();
    expect(jobs.resources.reservation(job.id).reservedBytes).toBe(0);
    t.f.grants.add(t.projectId);
    expect((await t.service.detail(job.id, t.actor)).phase).toBe("failed");
  } finally {
    await t.close();
  }
}, 30000);

test("queued native project cancellation and fresh dispatch honor ownership and current theme authority", async () => {
  const t = await nativeProjectBuildFixture();
  try {
    await t.place();
    const theme = await t.install();
    t.executor.faults.statusUnavailable = true;
    const cancelled = (await t.f.call("/api/site-builds", "POST", t.request(theme))).body.build as SiteBuild,
      revoked = (await t.f.call("/api/site-builds", "POST", t.request(theme))).body.build as SiteBuild;
    expect(
      (await t.f.call("/api/site-builds/cancel", "POST", { id: cancelled.id }, { "x-fixture-owner": "other" })).status,
    ).toBe(404);
    expect((await t.f.call("/api/site-builds/cancel", "POST", { id: cancelled.id })).status).toBe(200);
    t.themes.state(t.actor, theme, "disable", t.themes.snapshot(t.actor).revision);
    await t.restart();
    t.executor.faults.statusUnavailable = false;
    await waitFor(async () => (await t.service.detail(cancelled.id, t.actor)).phase === "cancelled");
    const failed = await waitFor(async () => {
      const job = await t.service.detail(revoked.id, t.actor);
      return job.phase === "failed" && job;
    });
    expect(failed.error).toBe("themeNotApproved");
    expect(t.executor.inputs.size).toBe(0);
    expect((await t.f.call("/api/site-builds", "POST", t.request(theme))).status).toBe(403);
  } finally {
    await t.close();
  }
}, 30000);
