import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { sourceStageFixture } from "../support/source-staging.js";
import { sourceIngestionFixture } from "../support/source-provider.js";
import { githubArchiveFixture } from "../support/github-archive.js";
import { sourceText } from "../support/linked-source.js";
import { uploadBody } from "../support/source-upload.js";
import { PackageSourceProviders } from "../../src/server/packages/ingestion/providers.js";
import { projectSourceAliases } from "../../src/shared/packages/sources/aliases.js";
import { contentSha256 } from "../../src/shared/packages/digest.js";
import { linkedSource } from "../support/linked-source.js";

test("source ingestion stores and restores raw GitHub language aliases under the accepted task policy", async () => {
  const f = await sourceStageFixture(),
    g = githubArchiveFixture("theme");
  g.linkTargets.set("default.ejs", sourceText("layout/page-0.ejs"));
  const r = sourceIngestionFixture(f, {
    provider: new PackageSourceProviders(
      g.http,
      async () => {
        throw Error("Unexpected original read");
      },
      { token: async () => "TEST_OWNER_CREDENTIAL" },
    ),
  });
  let closed = false;
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), {
      source: { kind: "github", ...g.request, ref: "main", repositoryId: 42 },
    });
    expect(stage.entryPolicy).toBe("logical-links/v2");
    r.manager.poll();
    await r.manager.settle();
    const ready = r.manager.read("owner", "templates", stage.id);
    expect(ready.state).toBe("ready");
    const captured = await r.stages.templates.content("owner", stage.id);
    expect(captured.links!.text("default.ejs")).toBe("layout/page-0.ejs");
    const names = await readdir(join(f.contentRoot, ready.id));
    expect(names).toEqual([captured.digest + ".source"]);
    const bytes = await readFile(join(f.contentRoot, ready.id, names[0]!));
    expect(bytes.length).toBe(ready.reservedBytes);
    expect(bytes.toString()).not.toMatch(/TEST_OWNER_CREDENTIAL|TEST_DOWNLOAD_QUERY/);
    await r.close();
    closed = true;
    const service = f.restart(),
      restored = await service.content("owner", ready.id);
    expect(restored.digest).toBe(captured.digest);
    expect((await projectSourceAliases(restored)).tree.text("default.ejs")).toBe("<h1>Original 0</h1>");
    expect(service.read("owner", ready.id).entryPolicy).toBe("logical-links/v2");
    await service.shutdown();
  } finally {
    if (!closed) await r.close();
    await f.dispose();
  }
});

test("real ZIP upload preserves original archives and link targets through durable capture and restart", async () => {
  const f = await sourceStageFixture(),
    r = sourceIngestionFixture(f),
    archive = zipSync({
      "theme/en.yml": sourceText("title: Hello"),
      "theme/default.yml": [sourceText("en.yml"), { os: 3, attrs: 0xa1ff0000 }],
    });
  let closed = false;
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), {
      source: { kind: "zip-upload", name: "theme.zip", bytes: archive.length, sha256: await contentSha256(archive) },
    });
    await r.manager.upload("owner", "templates", stage.id, stage.revision, uploadBody(archive).body);
    r.manager.poll();
    await r.manager.settle();
    expect(r.manager.read("owner", "templates", stage.id).state).toBe("ready");
    const captured = await r.stages.templates.content("owner", stage.id);
    expect(captured.readArchive()).toEqual(archive);
    expect(captured.links!.text("theme/default.yml")).toBe("en.yml");
    await r.close();
    closed = true;
    const service = f.restart(),
      restored = await service.content("owner", stage.id);
    expect(restored.readArchive()).toEqual(archive);
    expect((await projectSourceAliases(restored, "theme")).tree.text("default.yml")).toBe("title: Hello");
    await service.shutdown();
  } finally {
    if (!closed) await r.close();
    await f.dispose();
  }
});

test("upgrading old source tasks preserves fingerprints, v1 payloads and original admission policies", async () => {
  const f = await sourceStageFixture();
  try {
    let service = f.service(undefined, 5000);
    const operation = randomUUID(),
      stage = await service.submit("owner", operation, f.request()),
      ready = await service.execute("owner", stage.id, stage.revision, async () => f.snapshot),
      events = service.events("owner", stage.id),
      pending = await service.submit("owner", randomUUID(), {
        source: { kind: "github", repository: "example/theme", ref: "main" },
      });
    await service.shutdown();
    f.db.exec("ALTER TABLE package_source_stages DROP COLUMN entryPolicy; PRAGMA user_version=2;");
    service = f.restart();
    expect(service.read("owner", ready.id)).toEqual({ ...ready, entryPolicy: "regular-only/v1" });
    expect(service.events("owner", ready.id)).toEqual(events);
    expect((await service.content("owner", ready.id)).digest).toBe(f.snapshot.digest);
    expect((await service.submit("owner", operation, f.request())).id).toBe(ready.id);
    const rejected = await service.execute(
      "owner",
      pending.id,
      pending.revision,
      async (_actor, _purpose, _request, _signal, _limits, policy) => {
        expect(policy).toBe("regular-only/v1");
        const source = await linkedSource({ value: "Hello" }, { alias: "value" });
        return source;
      },
    );
    expect(rejected).toMatchObject({ state: "failed", failure: "unsupportedSourceEntry" });
    const next = await service.submit("owner", randomUUID(), f.request());
    expect(next.entryPolicy).toBe("logical-links/v2");
    await service.shutdown();
  } finally {
    await f.dispose();
  }
});
