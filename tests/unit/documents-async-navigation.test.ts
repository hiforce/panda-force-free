import { expect, test } from "bun:test";
import { MySQLDocumentNavigationBootstrap } from "../../src/server/documents/navigation/mysql-bootstrap.js";
import type { MySQLDocumentNavigationRepository } from "../../src/server/documents/navigation/mysql-repository.js";
import type { MySQLProjectDocumentLibrary } from "../../src/server/documents/mysql-library-service.js";
import type { MySQLDocumentService } from "../../src/server/documents/mysql-service.js";
import type { DocumentTreePlacement } from "../../src/shared/documents/navigation.js";

test("native document registration preserves sorted sibling positions when tombstone reads complete at different speeds", async () => {
  const inserted: DocumentTreePlacement[] = [],
    space = { id: "space" },
    documents = [
      { id: "first", path: "a.md" },
      { id: "second", path: "b.md" },
    ];
  const repository = {
    transaction: async (work: () => Promise<unknown>) => work(),
    version: async () => 1,
    rows: async () => [],
    unregistered: async () => documents,
    origins: async () => new Map(),
    tombstone: async (_space: string, id: string) => {
      await new Promise((resolve) => setTimeout(resolve, id === "first" ? 10 : 0));
      return null;
    },
    insert: async (_space: string, node: DocumentTreePlacement) => {
      inserted.push(node);
    },
    replace: async () => {},
    forgetTombstones: async () => {},
    bump: async () => {},
  } as unknown as MySQLDocumentNavigationRepository;
  const bootstrap = new MySQLDocumentNavigationBootstrap(
    repository,
    { get: async () => space } as unknown as MySQLProjectDocumentLibrary,
    {} as MySQLDocumentService,
  );
  await bootstrap.ensure("project");
  expect(inserted).toEqual([
    { documentId: "first", parentId: null, position: 0 },
    { documentId: "second", parentId: null, position: 1 },
  ]);
});
