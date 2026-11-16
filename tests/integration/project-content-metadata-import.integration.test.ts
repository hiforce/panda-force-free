import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { LegacyProjectDocuments } from "../../src/server/project-content/migration/legacy-documents.js";
import { importLegacyProjectContent } from "../../src/server/project-content/migration/import-project.js";
import { planLegacyMetadata } from "../../src/server/project-content/migration/metadata-plan.js";
import {
  beginLegacyImport,
  writeLegacyMetadataFile,
  completeLegacyImport,
} from "../../src/server/project-content/migration/write-metadata.js";
import { decodeProjectLegacyImport } from "../../src/server/project-content/migration/import-file.js";
import { createOwnedProjectDirectory } from "../../src/server/project-content/owned-directory.js";
import { openProjectAssetDirectory } from "../../src/server/project-content/asset-directory.js";
import { ProjectAssetBlobs } from "../../src/server/project-content/asset-blobs.js";
import { ProjectContentProject } from "../../src/server/project-content/project.js";
import { ProjectGitSnapshots } from "../../src/server/project-content/git/snapshot.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { legacyMetadataFixture } from "../support/legacy-metadata-fixture.js";

const author = { name: "Content migration", email: "migration@example.test" };
async function fixture(schema: 0 | 1 | 2 = 2) {
  const f = await legacyMetadataFixture(schema);
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#f04691" } })
        .png()
        .toBuffer(),
      digest = createHash("sha256").update(bytes).digest("hex"),
      legacyAssetRoot = join(f.root, "legacy-assets"),
      assetRoot = join(f.root, "target-assets");
    await mkdir(legacyAssetRoot);
    await mkdir(assetRoot);
    await writeFile(join(legacyAssetRoot, digest), bytes);
    const db = new Database(f.path);
    db.query("UPDATE document_assets SET digest=?,size=? WHERE id=?").run(digest, bytes.length, f.asset.id);
    db.query("INSERT INTO document_revision_assets VALUES(?,?,?,?)").run(
      f.first.revision.id,
      "images/original.png",
      f.asset.id,
      "images/original.png",
    );
    db.close();
    const owned = await createOwnedProjectDirectory(f.root, "project-1"),
      project = new ProjectContentProject(owned),
      assets = new ProjectAssetBlobs(await openProjectAssetDirectory(assetRoot, owned));
    return { ...f, owned, project, assets, legacyAssetRoot, bytes, digest, snapshots: new ProjectGitSnapshots(owned) };
  } catch (error) {
    await f.close();
    throw error;
  }
}

for (const schema of [0, 1, 2] as const)
  test(
    "full file migration retains metadata, binaries and every event independently of a schema-" + schema + " backup",
    async () => {
      const f = await fixture(schema);
      let source: LegacyProjectDocuments | undefined;
      try {
        const backup = await readFile(f.path);
        source = await LegacyProjectDocuments.open(f.path, "project-1");
        const metadata = source.metadata(),
          plan = planLegacyMetadata(source),
          input = {
            source,
            project: f.project,
            assets: f.assets,
            legacyAssetRoot: f.legacyAssetRoot,
            author: { ...author },
          },
          pending = importLegacyProjectContent(input);
        input.author.name = "Changed after call";
        input.legacyAssetRoot = join(f.root, "not-the-captured-source");
        const report = await pending,
          head = await f.snapshots.head();
        input.author = { ...author };
        input.legacyAssetRoot = f.legacyAssetRoot;
        expect(report.metadataMigrated).toBe(true);
        expect(report.assetsVerified).toBe(true);
        expect(report.applicationCutover).toBe(false);
        expect(report.spaces).toBe(2);
        expect(report.folders).toBe(1);
        expect(report.assets).toBe(1);
        expect(report.placementEvents).toBe(3);
        expect(report.generatedDirectories).toBe(schema === 0 ? 2 : 0);
        for (const value of metadata.spaces) expect(await f.project.spaces.get(value.space.id)).toEqual(value);
        expect((await f.project.spaces.library())?.id).toBe(f.library.id);
        expect((await f.project.assets.get(f.asset.id)).digest).toBe(f.digest);
        expect(await f.assets.read(f.digest, f.bytes.length)).toEqual(f.bytes);
        for (const state of plan.navigation.file.spaces)
          expect(await f.project.navigation.get(state.spaceId)).toEqual(state);
        for (const operation of plan.navigation.operations)
          expect(await f.project.navigationOperations.get(operation.id)).toEqual(operation);
        expect((await f.project.languages.list(f.first.document.id)).map((row) => row.id).sort()).toEqual(
          [f.first.document.id, f.translated.document.id].sort(),
        );
        for (const event of metadata.placements[0]!.events)
          expect(await f.project.placements.event("placement-1", event.placement.version)).toEqual({
            placement: event.placement,
            ...event.audit,
          });
        const imported = decodeProjectLegacyImport(
          (await f.project.coordinator.read(["import.json"])).files.get("import.json")!,
        );
        expect(imported.state).toBe("complete");
        expect(imported.folders[0]?.original).toEqual(metadata.folders[0]);
        if (schema === 0) {
          const folder = imported.folders[0]!.documentId!,
            document = await f.project.documents.get(folder);
          expect(document.document.title).toBe("original");
          expect(document.revision.body?.format).toBe("richtext");
          expect(
            plan.navigation.file.spaces
              .find((row) => row.spaceId === f.library.id)
              ?.nodes.find((row) => row.documentId === folder)?.parentId,
          ).not.toBeNull();
        }
        expect((await importLegacyProjectContent(input)).commit).toBe(report.commit);
        expect(await f.snapshots.head()).toBe(head);
        source.close();
        source = undefined;
        expect(await readFile(f.path)).toEqual(backup);
        await unlink(f.path);
        await unlink(join(f.legacyAssetRoot, f.digest));
        const reopened = new ProjectContentProject(f.owned);
        expect((await reopened.documents.get(f.first.document.id)).revision.content).toBe(f.first.revision.content);
        expect(
          (await reopened.documents.revision(f.first.document.id, f.first.revision.id)).resources?.[0]?.digest,
        ).toBe(f.digest);
        expect((await reopened.placements.history("placement-1")).map((row) => row.audit.operation)).toEqual([
          "remove",
          "update",
          "create",
        ]);
        expect(await f.assets.read(f.digest, f.bytes.length)).toEqual(f.bytes);
        expect((await f.snapshots.entries(head)).some((row) => row.path.includes(f.digest))).toBe(false);
      } finally {
        source?.close();
        await f.close();
      }
    },
    30000,
  );

test("migration resumes an interrupted metadata stage and never adopts a different backup or preexisting content", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    source = await LegacyProjectDocuments.open(f.path, "project-1");
    const plan = planLegacyMetadata(source);
    await beginLegacyImport(f.project, plan, author);
    const entry = [...plan.files].find(([path]) => path.startsWith("spaces/"))!;
    await writeLegacyMetadataFile(f.project, source.sourceHash, entry[0], entry[1], author);
    expect(
      decodeProjectLegacyImport((await f.project.coordinator.read(["import.json"])).files.get("import.json")!).state,
    ).toBe("importing");
    const staleCommit = await f.snapshots.head();
    const another = [...plan.files].find(([path]) => path.startsWith("spaces/") && path !== entry[0])!;
    await writeLegacyMetadataFile(f.project, source.sourceHash, another[0], another[1], author);
    await expect(completeLegacyImport(f.project, plan.marker, author, staleCommit)).rejects.toThrow("conflict");
    expect(
      decodeProjectLegacyImport((await f.project.coordinator.read(["import.json"])).files.get("import.json")!).state,
    ).toBe("importing");
    const reopened = new ProjectContentProject(f.owned),
      report = await importLegacyProjectContent({
        source,
        project: reopened,
        assets: f.assets,
        legacyAssetRoot: f.legacyAssetRoot,
        author,
      });
    expect(report.metadataMigrated).toBe(true);
    const head = await f.snapshots.head();
    source.close();
    source = undefined;
    const db = new Database(f.path);
    db.query("UPDATE document_spaces SET name='Changed backup' WHERE id=?").run(f.library.id);
    db.close();
    source = await LegacyProjectDocuments.open(f.path, "project-1");
    await expect(
      importLegacyProjectContent({
        source,
        project: reopened,
        assets: f.assets,
        legacyAssetRoot: f.legacyAssetRoot,
        author,
      }),
    ).rejects.toThrow("conflict");
    expect(await f.snapshots.head()).toBe(head);
  } finally {
    source?.close();
    await f.close();
  }
}, 30000);

test("binary format, dimension and late metadata corruption fail before the first target content write", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    const head = await f.snapshots.head(),
      original = await readFile(f.path);
    for (const change of [
      "UPDATE document_assets SET width=3",
      "UPDATE document_assets SET mime='image/jpeg'",
      "UPDATE document_placement_events SET operation='update' WHERE version=1",
      "corrupt-binary",
    ]) {
      await writeFile(f.path, original);
      const db = new Database(f.path);
      if (change === "corrupt-binary") {
        const bytes = Buffer.from("Incorrect image bytes with a correct recorded digest"),
          digest = createHash("sha256").update(bytes).digest("hex");
        await writeFile(join(f.legacyAssetRoot, digest), bytes);
        db.query("UPDATE document_assets SET digest=?,size=?").run(digest, bytes.length);
      } else db.exec(change);
      db.close();
      source = await LegacyProjectDocuments.open(f.path, "project-1");
      await expect(
        importLegacyProjectContent({
          source,
          project: f.project,
          assets: f.assets,
          legacyAssetRoot: f.legacyAssetRoot,
          author,
        }),
      ).rejects.toThrow("invalidFile");
      source.close();
      source = undefined;
      expect(await f.snapshots.head()).toBe(head);
      expect(await f.snapshots.entries(head)).toEqual([]);
    }
  } finally {
    source?.close();
    await f.close();
  }
}, 30000);

test("an import cannot adopt preexisting project files, cross project ownership, or overlapping binary roots", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    source = await LegacyProjectDocuments.open(f.path, "project-1");
    const existing = projectDocumentFixture();
    await f.project.documents.put(existing, null, "preexisting", author);
    const head = await f.snapshots.head();
    await expect(
      importLegacyProjectContent({
        source,
        project: f.project,
        assets: f.assets,
        legacyAssetRoot: f.legacyAssetRoot,
        author,
      }),
    ).rejects.toThrow("conflict");
    expect(await f.snapshots.head()).toBe(head);
    expect(await f.project.documents.get(existing.document.id)).toEqual(existing);
    await expect(
      importLegacyProjectContent({
        source,
        project: f.project,
        assets: f.assets,
        legacyAssetRoot: f.assets.owned.blobs,
        author,
      }),
    ).rejects.toThrow("unowned");
    const foreign = await createOwnedProjectDirectory(f.root, "other-project");
    await expect(
      importLegacyProjectContent({
        source,
        project: new ProjectContentProject(foreign),
        assets: f.assets,
        legacyAssetRoot: f.legacyAssetRoot,
        author,
      }),
    ).rejects.toThrow("unowned");
    expect(await f.snapshots.head()).toBe(head);
  } finally {
    source?.close();
    await f.close();
  }
}, 30000);

test("the original content schema imports without optional metadata tables or an attachment source", async () => {
  const f = await fixture();
  let source: LegacyProjectDocuments | undefined;
  try {
    const path = join(f.root, "original-v1.sqlite"),
      db = new Database(path),
      document = projectDocumentFixture();
    db.exec(`CREATE TABLE document_spaces(id TEXT PRIMARY KEY,projectId TEXT,code TEXT,name TEXT,engine TEXT,theme TEXT,sourceMode TEXT,sourceRoot TEXT,locale TEXT,version INTEGER,createdAt INTEGER,updatedAt INTEGER);
      CREATE TABLE documents(id TEXT PRIMARY KEY,spaceId TEXT,path TEXT,title TEXT,locale TEXT,revision INTEGER,revisionId TEXT,contentHash TEXT,importedHash TEXT,importedRevision INTEGER,updatedAt INTEGER);
      CREATE TABLE document_revisions(id TEXT PRIMARY KEY,documentId TEXT,number INTEGER,title TEXT,locale TEXT,content TEXT,contentHash TEXT,createdAt INTEGER);
      PRAGMA user_version=1;`);
    db.query("INSERT INTO document_spaces VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "space-1",
      "project-1",
      "legacy",
      "Legacy source",
      "markdown",
      "default",
      "managed",
      "/isolated/legacy",
      "en",
      1,
      100,
      100,
    );
    document.revision.resources = [];
    const d = document.document,
      r = document.revision;
    db.query("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      d.id,
      d.spaceId,
      d.path,
      d.title,
      d.locale,
      d.revision,
      d.revisionId,
      d.contentHash,
      d.importedHash,
      d.importedRevision,
      d.updatedAt,
    );
    db.query("INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?,?)").run(
      r.id,
      r.documentId,
      r.number,
      r.title,
      r.locale,
      r.content,
      r.contentHash,
      r.createdAt,
    );
    db.close();
    const bytes = await readFile(path);
    source = await LegacyProjectDocuments.open(path, "project-1");
    const report = await importLegacyProjectContent({ source, project: f.project, assets: f.assets, author });
    expect(report.sourceSchema).toBe(1);
    expect(report.assets).toBe(0);
    expect(report.revisions).toBe(1);
    expect(await f.project.documents.get(d.id)).toEqual(document);
    expect(await f.project.spaces.library()).toBeNull();
    expect((await f.project.spaces.list())[0]?.code).toBe("legacy");
    source.close();
    source = undefined;
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    source?.close();
    await f.close();
  }
}, 30000);
