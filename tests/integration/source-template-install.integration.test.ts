import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { portableSourceArchive, sourceTemplateFixture } from "../support/source-template.js";
import { deferred } from "../support/source-staging.js";
import { parsePortableTemplateBundle } from "../../src/shared/templates/portable/bundle.js";
import { PortableTemplateSource } from "../../src/server/templates/portable/source.js";
import { fixtureBytes } from "../support/portable-templates.js";
import { githubTemplateSource } from "../support/github-template-source.js";

const article = "example.article-outline@1.0.0",
  slides = "example.brand-slides@1.0.0";

test("source digest, selection and root changes cannot reuse an approval or install a different library", async () => {
  const f = await sourceTemplateFixture(),
    archive = await portableSourceArchive();
  try {
    const task = await f.stage(archive.bytes),
      reference = { id: task.id, sha256: task.digest!, root: archive.root },
      s = f.services(),
      review = await s.importer.review("owner", { ...reference, selected: [article] }),
      command = {
        ...reference,
        approval: {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
        },
      };
    await expect(s.importer.install("owner", { ...command, sha256: "0".repeat(64) })).rejects.toThrow("stageConflict");
    await expect(s.importer.install("owner", { ...command, root: "other-library" })).rejects.toThrow("resourceMissing");
    await expect(
      s.importer.install("owner", { ...command, approval: { ...command.approval, selected: [slides] } }),
    ).rejects.toThrow("reviewChanged");
    expect(s.inspection.snapshot()).toEqual({ revision: 0, templates: [] });
  } finally {
    await f.close();
  }
}, 15000);

test("GitHub library installation retains pinned repository, commit and root lineage instead of inventing an upload origin", async () => {
  const archive = await portableSourceArchive(),
    github = await githubTemplateSource(archive.bytes),
    f = await sourceTemplateFixture({ http: github.http });
  try {
    const submitted = await f.manager.submit("owner", "templates", randomUUID(), {
      source: { kind: "github", repository: "example/templates", ref: "main", root: "", repositoryId: 42 },
    });
    f.manager.poll();
    await f.manager.settle();
    const task = f.manager.read("owner", "templates", submitted.id);
    expect(task.state).toBe("ready");
    const s = f.services(),
      reference = { id: task.id, sha256: task.digest!, root: archive.root },
      review = await s.importer.review("owner", { ...reference, selected: [article] }),
      installed = await s.importer.install("owner", {
        ...reference,
        approval: {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
        },
      });
    expect(installed.current.templates[0]!.origin).toEqual({
      kind: "captured",
      root: archive.root,
      sha256: reference.sha256,
      source: {
        kind: "github",
        repository: "https://github.com/example/templates",
        repositoryId: 42,
        requestedRef: "main",
        root: "",
        commit: github.commit,
        tree: github.tree,
      },
    });
    expect(github.calls.every((call) => call.headers.Authorization === undefined)).toBe(true);
    expect(f.restart().inspection.snapshot()).toEqual(installed.current);
  } finally {
    await f.close();
  }
}, 15000);
test("captured libraries install selected exact resources, keep provenance and replay receipts after source cleanup and registry restart", async () => {
  const f = await sourceTemplateFixture(),
    archive = await portableSourceArchive();
  try {
    const task = await f.stage(archive.bytes);
    expect(task.state).toBe("ready");
    const reference = { id: task.id, sha256: task.digest!, root: archive.root };
    let s = f.services();
    const review = await s.importer.review("owner", { ...reference, selected: [article, slides] });
    expect(review.source).toMatchObject({
      kind: "captured",
      root: archive.root,
      sha256: task.digest,
      source: { kind: "zip-upload", name: "library.zip" },
    });
    const command = {
        ...reference,
        approval: {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
        },
      },
      installed = await s.importer.install("owner", command);
    expect(installed.receipt.results.map((value) => value.status)).toEqual(["installed", "installed"]);
    expect(installed.current.templates).toHaveLength(2);
    const target = installed.current.templates.find((value) => value.id === "example.article-outline")!,
      exported = await s.inspection.export(target.id, target.version, target.digest),
      parsed = await parsePortableTemplateBundle(exported);
    expect(parsed.templates[0]!.digest).toBe(target.digest);
    expect(new TextDecoder().decode(exported)).not.toContain("README.md");
    const disabled = s.inspection.state(
      target.id,
      target.version,
      target.digest,
      "disable",
      installed.current.revision,
      "owner",
    );
    expect((await f.manager.remove("owner", "templates", task.id, task.revision)).state).toBe("removed");
    s = f.restart();
    const replay = await s.importer.install("owner", command);
    expect(replay.receipt).toEqual(installed.receipt);
    expect(replay.current.revision).toBe(disabled.revision);
    expect(replay.current.templates.find((value) => value.id === target.id)!.enabled).toBe(false);
    expect(await s.inspection.export(target.id, target.version, target.digest)).toEqual(exported);
    await expect(s.importer.install("owner", { ...command, sha256: "0".repeat(64) })).rejects.toThrow(
      "operationConflict",
    );
    await expect(
      s.importer.install("owner", { ...command, approval: { ...command.approval, reviewHash: "0".repeat(64) } }),
    ).rejects.toThrow("operationConflict");
    await expect(s.importer.install("other", command)).rejects.toThrow("stageNotFound");
  } finally {
    await f.close();
  }
}, 15000);

test("accepted installation finishes with a durable receipt when the intake is removed during its content write", async () => {
  const f = await sourceTemplateFixture(),
    archive = await portableSourceArchive(),
    entered = deferred<void>(),
    release = deferred<void>();
  try {
    const task = await f.stage(archive.bytes),
      reference = { id: task.id, sha256: task.digest!, root: archive.root },
      s = f.services({
        read: (digest) => f.content.read(digest),
        async put(value) {
          entered.resolve();
          await release.promise;
          await f.content.put(value);
        },
      }),
      review = await s.importer.review("owner", { ...reference, selected: [article] }),
      command = {
        ...reference,
        approval: {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
        },
      },
      pending = s.importer.install("owner", command),
      observed = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await entered.promise;
    expect(f.manager.runtime.snapshot().active).toBe(1);
    await f.manager.remove("owner", "templates", task.id, task.revision);
    expect(f.manager.runtime.snapshot().active).toBe(1);
    release.resolve();
    const outcome = await observed;
    if (!("value" in outcome)) throw outcome.error;
    expect(outcome.value.receipt.results[0]!.status).toBe("installed");
    expect(f.manager.runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
    expect((await s.importer.install("owner", command)).receipt).toEqual(outcome.value.receipt);
  } finally {
    release.resolve();
    await f.close();
  }
}, 15000);

test("metadata version four preserves legacy upload lineage, request fingerprints and receipt bytes", async () => {
  const f = await sourceTemplateFixture(),
    archive = await portableSourceArchive();
  try {
    const s = f.services(),
      source = await PortableTemplateSource.read(fixtureBytes(archive.bundle), "legacy.json"),
      review = await s.installation.review(source, [article]),
      command = {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        selected: review.selected,
      },
      installed = await s.installation.install(source, command, "owner"),
      rows = f.db.query("SELECT * FROM portable_template_operations").all(),
      versions = f.db.query("SELECT * FROM portable_template_versions").all();
    f.db.exec("PRAGMA user_version=3");
    const restored = f.restart();
    expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(f.db.query("SELECT * FROM portable_template_operations").all()).toEqual(rows);
    expect(f.db.query("SELECT * FROM portable_template_versions").all()).toEqual(versions);
    expect((await restored.installation.install(source, command, "owner")).receipt).toEqual(installed.receipt);
  } finally {
    await f.close();
  }
}, 15000);
