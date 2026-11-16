import { expect, test } from "bun:test";
import {
  decodeAssetRecord,
  encodeAssetRecords,
  decodeAssetRecords,
  projectAssetShard,
} from "../../src/server/project-content/asset-file.js";
import { decodeProjectLanguages, encodeProjectLanguages } from "../../src/server/project-content/language-file.js";
import {
  decodeNavigationOperations,
  encodeNavigationOperations,
  navigationOperationShard,
} from "../../src/server/project-content/navigation-operation-file.js";
import {
  decodePlacementRecords,
  encodePlacementRecords,
  type ProjectPlacementFile,
} from "../../src/server/project-content/placement-file.js";
import { projectRecordShard } from "../../src/server/project-content/record-shards.js";

test("related records preserve filenames, explicit language membership, old operation ownership and null legacy receipts", () => {
  const asset = {
    id: "asset-1",
    documentId: "doc-1",
    name: "原始 image.png",
    mime: "image/png",
    digest: "a".repeat(64),
    size: 100,
    width: 2,
    height: 3,
    alt: "Original image",
    createdAt: 100,
  };
  const assets = { schema: 1 as const, projectId: "project-1", shard: projectAssetShard(asset.id), assets: [asset] };
  expect(decodeAssetRecords(encodeAssetRecords(assets))).toEqual(assets);
  const languages = {
    schema: 1 as const,
    projectId: "project-1",
    version: 0,
    groups: [{ id: "original-group", documentIds: ["doc-1", "doc-2"] }],
  };
  expect(decodeProjectLanguages(encodeProjectLanguages(languages))).toEqual(languages);
  const operation = {
    id: "operation-1",
    spaceId: "space-1",
    owner: "provider:original-user",
    documentId: "doc-1",
    request: "b".repeat(64),
    createdAt: 123,
    result: null,
  };
  const file = {
    schema: 1 as const,
    projectId: "project-1",
    shard: navigationOperationShard(operation.id),
    operations: [operation],
  };
  expect(decodeNavigationOperations(encodeNavigationOperations(file))).toEqual(file);
  const legacy = {
    ...file,
    operations: [
      { ...operation, request: '{"kind":"move","oldBody":"retained verbatim"}', legacyRequest: true as const },
    ],
  };
  expect(decodeNavigationOperations(encodeNavigationOperations(legacy))).toEqual(legacy);
  expect(() =>
    encodeNavigationOperations({ ...legacy, operations: [{ ...legacy.operations[0]!, legacyRequest: undefined }] }),
  ).toThrow("invalidFile");
});

test("record shards reject duplicate identities, wrong placement and binary or secret fields", () => {
  const asset = {
      id: "asset-1",
      documentId: "doc-1",
      name: "image.png",
      mime: "image/png",
      digest: "a".repeat(64),
      size: 100,
      width: 2,
      height: 3,
      alt: "",
      createdAt: 100,
    },
    valid = { schema: 1, projectId: "project-1", shard: projectAssetShard(asset.id), assets: [asset] };
  for (const value of [
    { ...valid, assets: [asset, asset] },
    { ...valid, shard: valid.shard === "00" ? "01" : "00" },
    { ...valid, assets: [{ ...asset, bytes: "must not be stored" }] },
    { ...valid, token: "example-only" },
  ])
    expect(() => decodeAssetRecords(JSON.stringify(value))).toThrow("invalidFile");
  expect(() => decodeAssetRecord({ ...asset, name: "../image.png" })).toThrow("invalidFile");
  expect(() => decodeAssetRecord({ ...asset, name: "line\nname.png" })).toThrow("invalidFile");
  expect(() => decodeAssetRecord({ ...asset, name: "tab\tname.png" })).toThrow("invalidFile");
  expect(() => decodeAssetRecord({ ...asset, width: 16000001 })).toThrow("invalidFile");
  expect(() =>
    decodeProjectLanguages(
      JSON.stringify({
        schema: 1,
        projectId: "project-1",
        version: 1,
        groups: [
          { id: "a", documentIds: ["doc-1"] },
          { id: "b", documentIds: ["doc-1"] },
        ],
      }),
    ),
  ).toThrow("invalidFile");
});

test("placement snapshots retain custom historical metadata, audit actors and removal versions", () => {
  const record: ProjectPlacementFile = {
    schema: 1,
    placement: {
      id: "placement-1",
      projectId: "project-1",
      documentId: "doc-1",
      spaceId: "publication",
      path: "guide/原稿.md",
      locale: "zh-CN",
      revisionId: "revision-1",
      metadata: { title: "Original title", custom_topic: "custom metadata" },
      version: 2,
      createdAt: 100,
      updatedAt: 200,
      deletedAt: null,
    },
    audit: { operation: "update", actor: "original-user", createdAt: 201 },
  };
  const file = {
    schema: 1 as const,
    projectId: "project-1",
    shard: projectRecordShard(record.placement.id),
    placements: [record],
  };
  expect(decodePlacementRecords(encodePlacementRecords(file))).toEqual(file);
  const removed = structuredClone(file);
  removed.placements[0]!.placement.deletedAt = 300;
  removed.placements[0]!.placement.version = 3;
  removed.placements[0]!.audit.operation = "remove";
  expect(decodePlacementRecords(encodePlacementRecords(removed))).toEqual(removed);
  const wrong = structuredClone(file);
  wrong.placements[0]!.placement.projectId = "other";
  expect(() => decodePlacementRecords(JSON.stringify(wrong))).toThrow("invalidFile");
  const secret = structuredClone(file);
  secret.placements[0]!.placement.metadata = { access_token: "example-only" };
  expect(() => decodePlacementRecords(JSON.stringify(secret))).toThrow("invalidFile");
  const missingCreate = structuredClone(file);
  missingCreate.placements[0]!.placement.version = 1;
  expect(() => encodePlacementRecords(missingCreate)).toThrow("invalidFile");
});
