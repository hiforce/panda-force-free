import { expect, test } from "bun:test";
import {
  decodeProjectNavigation,
  encodeProjectNavigation,
  type ProjectNavigationFile,
} from "../../src/server/project-content/navigation-file.js";

function fixture(): ProjectNavigationFile {
  return {
    schema: 1,
    projectId: "project-1",
    spaces: [
      {
        spaceId: "space-1",
        version: 7,
        nodes: [{ documentId: "active", parentId: null, position: 0 }],
        trash: [
          { documentId: "deleted", deletedAt: 111, parentId: "former-parent", position: 2, operationId: "trash-1" },
          { documentId: "child", deletedAt: 111, parentId: "deleted", position: 0, operationId: "trash-1" },
          { documentId: "legacy", deletedAt: 90, parentId: null, position: null, operationId: null },
        ],
        origins: [{ path: "source/guide", documentId: "active" }],
        lastOperation: {
          id: "operation-7",
          documentId: "active",
          affectedDocumentIds: ["active"],
          treeVersion: 7,
          restoredToRoot: false,
        },
      },
    ],
  };
}
test("navigation snapshots preserve live nodes, missing saved parents, legacy trash and folder origins without bodies", () => {
  const original = fixture(),
    encoded = encodeProjectNavigation(original);
  expect(decodeProjectNavigation(encoded)).toEqual(original);
  expect(encoded).not.toContain('"content"');
  expect(encoded).not.toContain('"body"');
});
test("navigation decoding rejects cycles, duplicate live/trash identities, invalid tombstones and receipts", () => {
  const valid = fixture();
  for (const modify of [
    (v: ProjectNavigationFile) => {
      v.spaces[0]!.nodes[0]!.parentId = "active";
    },
    (v: ProjectNavigationFile) => {
      v.spaces[0]!.trash[0]!.documentId = "active";
    },
    (v: ProjectNavigationFile) => {
      v.spaces[0]!.trash[0]!.parentId = "child";
    },
    (v: ProjectNavigationFile) => {
      v.spaces[0]!.trash[0]!.operationId = null;
    },
    (v: ProjectNavigationFile) => {
      v.spaces[0]!.lastOperation!.treeVersion = 6;
    },
    (v: ProjectNavigationFile) => {
      v.spaces[0]!.origins[0]!.path = "../escape";
    },
    (v: ProjectNavigationFile) => {
      v.spaces.push(structuredClone(v.spaces[0]!));
    },
  ]) {
    const next = structuredClone(valid);
    modify(next);
    expect(() => decodeProjectNavigation(JSON.stringify(next))).toThrow("invalidFile");
  }
  expect(() => decodeProjectNavigation(JSON.stringify({ ...valid, schema: 2 }))).toThrow("unsupportedSchema");
});
