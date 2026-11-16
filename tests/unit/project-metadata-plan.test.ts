import { expect, test } from "bun:test";
import type { LegacyProjectMetadata } from "../../src/server/project-content/migration/legacy-metadata.js";
import { planLegacyNavigation } from "../../src/server/project-content/migration/navigation-plan.js";
import {
  encodeProjectLegacyImport,
  decodeProjectLegacyImport,
} from "../../src/server/project-content/migration/import-file.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";

function metadata(): LegacyProjectMetadata {
  return {
    projectId: "project-1",
    spaces: [projectSpaceFixture("space-1", true)],
    librarySpaceId: "space-1",
    assets: [],
    languages: { schema: 1, projectId: "project-1", version: 0, groups: [] },
    folders: [],
    trash: [],
    placements: [],
    navigation: { schema: 2, versions: [], nodes: [], tombstones: [], origins: [], operations: [] },
  };
}

test("initial directory conversion has stable identities, full ancestry and preserved original documents", () => {
  const value = metadata(),
    doc = projectDocumentFixture().document;
  doc.path = "guides/中文/guide.md";
  value.folders = [{ id: "folder", spaceId: "space-1", path: "empty/child", version: 4, createdAt: 1, updatedAt: 2 }];
  const first = planLegacyNavigation(value, [doc]),
    second = planLegacyNavigation(structuredClone(value), [structuredClone(doc)]),
    tree = first.file.spaces[0]!;
  expect(second).toEqual(first);
  expect(first.generated).toHaveLength(4);
  const parent = tree.origins.find((row) => row.path === "guides/中文")!.documentId;
  expect(tree.nodes.find((row) => row.documentId === doc.id)?.parentId).toBe(parent);
  expect(first.generated.find((row) => row.document.title === "child")?.document.updatedAt).toBe(2);
  expect(first.generated.find((row) => row.document.title === "child")?.revision.createdAt).toBe(1);
  expect(doc.path).toBe("guides/中文/guide.md");
  const collision = structuredClone(doc);
  collision.id = first.generated[0]!.document.id;
  expect(() => planLegacyNavigation(value, [doc, collision])).toThrow("conflict");
});

test("initialized tree order and old null receipts remain exact until a compatibility edit is needed", () => {
  const value = metadata(),
    docs = [projectDocumentFixture(1, "one").document, projectDocumentFixture(1, "two").document];
  value.navigation.versions = [{ spaceId: "space-1", version: 9 }];
  value.navigation.nodes = [
    { spaceId: "space-1", documentId: "one", parentId: null, position: 7 },
    { spaceId: "space-1", documentId: "two", parentId: "one", position: 4 },
  ];
  value.navigation.operations = [
    {
      id: "old",
      spaceId: "space-1",
      owner: "legacy-owner",
      request: "opaque request",
      legacyRequest: true,
      documentId: "one",
      createdAt: 12,
      result: null,
    },
  ];
  const next = planLegacyNavigation(value, docs);
  expect(next.generated).toEqual([]);
  expect(next.operations).toEqual(value.navigation.operations);
  expect(next.file.spaces[0]?.version).toBe(9);
  expect(next.file.spaces[0]?.nodes).toEqual(
    value.navigation.nodes.map(({ spaceId, ...node }) => {
      void spaceId;
      return node;
    }),
  );
  expect(next.file.spaces[0]?.lastOperation).toBeNull();
  value.trash = [{ documentId: "one", deletedAt: 100 }];
  const deleted = planLegacyNavigation(value, docs),
    state = deleted.file.spaces[0]!;
  expect(state.version).toBe(10);
  expect(state.nodes).toEqual([{ documentId: "two", parentId: null, position: 0 }]);
  expect(state.trash[0]).toMatchObject({ documentId: "one", parentId: null, position: 7 });
  expect(deleted.operations.at(-1)?.result?.affectedDocumentIds).toEqual(["one"]);
  expect(state.lastOperation?.id ?? null).toBe(state.trash[0]?.operationId ?? null);
  expect(planLegacyNavigation(value, docs)).toEqual(deleted);
});

test("already-retired schema-one nodes retain their original operation and restoration position", () => {
  const value = metadata(),
    docs = [projectDocumentFixture(1, "one").document, projectDocumentFixture(1, "two").document];
  value.navigation.schema = 1;
  value.navigation.versions = [{ spaceId: "space-1", version: 8 }];
  value.navigation.nodes = [
    { spaceId: "space-1", documentId: "one", parentId: null, position: 0 },
    { spaceId: "space-1", documentId: "two", parentId: "one", position: 3 },
  ];
  value.navigation.tombstones = [{ ...value.navigation.nodes[1]!, operationId: "retire" }];
  value.navigation.operations = [
    {
      id: "retire",
      spaceId: "space-1",
      owner: "owner",
      request: "old",
      legacyRequest: true,
      documentId: "two",
      createdAt: 10,
      result: null,
    },
  ];
  value.trash = [{ documentId: "two", deletedAt: 11 }];
  const next = planLegacyNavigation(value, docs);
  expect(next.operations).toEqual(value.navigation.operations);
  expect(next.file.spaces[0]?.trash).toEqual([
    { documentId: "two", deletedAt: 11, parentId: "one", position: 3, operationId: "retire" },
  ]);
  expect(next.file.spaces[0]?.nodes).toEqual([{ documentId: "one", parentId: null, position: 0 }]);
});

test("portable import provenance retains original folder metadata and rejects unknown or repeated records", () => {
  const valid = {
    schema: 1 as const,
    state: "importing" as const,
    projectId: "project-1",
    sourceHash: "a".repeat(64),
    sourceSchema: 6,
    navigationSchema: 0,
    folders: [
      {
        original: { id: "folder", spaceId: "space-1", path: "guides/中文", version: 4, createdAt: 100, updatedAt: 200 },
        documentId: "converted-document",
      },
    ],
  };
  expect(decodeProjectLegacyImport(encodeProjectLegacyImport(valid))).toEqual(valid);
  for (const value of [
    { ...valid, token: "example-only" },
    { ...valid, state: "active" },
    { ...valid, folders: [...valid.folders, ...valid.folders] },
    {
      ...valid,
      folders: [{ ...valid.folders[0]!, original: { ...valid.folders[0]!.original, path: "../elsewhere" } }],
    },
  ])
    expect(() => decodeProjectLegacyImport(JSON.stringify(value))).toThrow("invalidFile");
});
