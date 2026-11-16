import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { LegacyProjectDocuments } from "../../src/server/project-content/migration/legacy-documents.js";
import { legacyMetadataFixture as fixture } from "../support/legacy-metadata-fixture.js";

test.concurrent(
  "read-only inventory retains spaces, source profiles, translations, attachments and complete placement audit",
  async () => {
    const f = await fixture();
    let source: LegacyProjectDocuments | undefined;
    try {
      const bytes = await readFile(f.path);
      source = await LegacyProjectDocuments.open(f.path, "project-1");
      const metadata = source.metadata();
      expect(metadata.spaces.map((row) => row.space)).toEqual(f.expectedSpaces);
      expect(metadata.spaces.find((row) => row.space.id === "publication")!.sourceProfile).toEqual(f.profile);
      expect(metadata.librarySpaceId).toBe(f.library.id);
      expect(metadata.assets).toEqual([f.asset]);
      expect(metadata.languages.groups).toEqual([
        { id: "original-language-group", documentIds: [f.first.document.id, f.translated.document.id].sort() },
      ]);
      expect(metadata.folders).toEqual([
        { id: "folder-1", spaceId: f.library.id, path: "guides/original", version: 4, createdAt: 100, updatedAt: 200 },
      ]);
      expect(metadata.placements[0]!.current).toEqual(f.removed);
      expect(metadata.placements[0]!.events.map(({ placement, audit }) => ({ placement, ...audit }))).toEqual(
        f.history,
      );
      expect(metadata.navigation.schema).toBe(2);
      expect(metadata.navigation.nodes.map((row) => row.documentId).sort()).toEqual(
        [f.first.document.id, f.translated.document.id].sort(),
      );
      expect(metadata.navigation.tombstones).toEqual([
        {
          spaceId: f.library.id,
          documentId: f.retired.document.id,
          parentId: null,
          position: 1,
          operationId: "retire",
        },
      ]);
      expect(metadata.navigation.operations[0]!.owner).toBe("provider:original-user");
      expect(metadata.navigation.operations[0]!.result!.treeVersion).toBe(2);
      expect(JSON.stringify(metadata)).not.toContain("Unmodified source body");
      await source.assertSourceUnchanged();
      source.close();
      source = undefined;
      expect(await readFile(f.path)).toEqual(bytes);
    } finally {
      source?.close();
      await f.close();
    }
  },
);

test.concurrent(
  "metadata inventory preserves unbootstrapped and schema-one navigation without rewriting old records",
  async () => {
    for (const schema of [0, 1] as const) {
      const f = await fixture(schema);
      let source: LegacyProjectDocuments | undefined;
      try {
        const bytes = await readFile(f.path);
        source = await LegacyProjectDocuments.open(f.path, "project-1");
        const metadata = source.metadata();
        expect(metadata.navigation.schema).toBe(schema);
        if (schema === 0) expect(metadata.navigation.nodes).toEqual([]);
        else {
          expect(metadata.navigation.nodes).toHaveLength(3);
          expect(metadata.navigation.tombstones).toEqual([
            { ...f.nodes[2]!, spaceId: f.library.id, operationId: "retire" },
          ]);
          expect(metadata.navigation.operations[0]).toEqual({
            id: "retire",
            spaceId: f.library.id,
            owner: "provider:old-user",
            request: "old-request",
            legacyRequest: true,
            documentId: f.retired.document.id,
            createdAt: 456,
            result: null,
          });
        }
        source.close();
        source = undefined;
        expect(await readFile(f.path)).toEqual(bytes);
      } finally {
        source?.close();
        await f.close();
      }
    }
  },
);

test.concurrent(
  "metadata inventory rejects broken placement history and future navigation before writing target state",
  async () => {
    const f = await fixture();
    let source: LegacyProjectDocuments | undefined;
    try {
      let db = new Database(f.path);
      db.query("UPDATE document_placement_events SET operation='update' WHERE placementId=? AND version=1").run(
        "placement-1",
      );
      db.close();
      source = await LegacyProjectDocuments.open(f.path, "project-1");
      expect(() => source!.metadata()).toThrow("invalidFile");
      source.close();
      source = undefined;
      db = new Database(f.path);
      db.query("UPDATE document_placement_events SET operation='create' WHERE placementId=? AND version=1").run(
        "placement-1",
      );
      db.exec("UPDATE document_navigation_schema SET version=3");
      db.close();
      source = await LegacyProjectDocuments.open(f.path, "project-1");
      expect(() => source!.metadata()).toThrow("unsupportedSchema");
    } finally {
      source?.close();
      await f.close();
    }
  },
);
