import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDocumentDatabase } from "../../src/server/documents/database.js";
import { SpaceRepository } from "../../src/server/documents/space-repository.js";
import { DocumentRepository } from "../../src/server/documents/document-repository.js";
import { DocumentAssetRepository } from "../../src/server/documents/asset-repository.js";
import { ProjectLibraryRepository } from "../../src/server/documents/library-repository.js";
import { DocumentNavigationRepository } from "../../src/server/documents/navigation/repository.js";
import { DocumentPlacementRepository } from "../../src/server/documents/placements/repository.js";
import { projectSpaceProfile } from "./project-space-fixture.js";

export async function legacyMetadataFixture(navigation: 0 | 1 | 2 = 2) {
  const root = await mkdtemp(join(tmpdir(), "panda-metadata-inventory-")),
    path = join(root, "source.sqlite");
  const db = openDocumentDatabase(path);
  try {
    // Seed one consistent backup transaction; the reader still opens the closed on-disk database with its default settings.
    const data = db
      .transaction(() => {
        const spaces = new SpaceRepository(db),
          library = new ProjectLibraryRepository(db, spaces).ensure(
            "project-1",
            "en",
            "library",
            join(root, "library"),
          ),
          publication = spaces.create(
            {
              projectId: "project-1",
              code: "publication",
              name: "Original site",
              engine: "hexo",
              theme: "default",
              sourceMode: "managed",
              locale: "en",
            },
            join(root, "publication"),
            "publication",
          ),
          docs = new DocumentRepository(db),
          first = docs.create(library.id, "original.md", {
            title: "Original",
            locale: "en",
            content: "Unmodified source body",
          }),
          translated = docs.create(library.id, "translated.md", {
            title: "原稿",
            locale: "zh-CN",
            content: "原稿正文",
          }),
          retired = docs.create(library.id, "old.md", { title: "Retired", locale: "fr", content: "Old body" }),
          profile = projectSpaceProfile();
        db.query("INSERT INTO document_site_profiles VALUES(?,?)").run(publication.id, JSON.stringify(profile));
        db.query("INSERT INTO document_languages VALUES(?,?)").run(first.document.id, "original-language-group");
        db.query("INSERT INTO document_languages VALUES(?,?)").run(translated.document.id, "original-language-group");
        db.query("INSERT INTO document_folders VALUES(?,?,?,?,?,?)").run(
          "folder-1",
          library.id,
          "guides/original",
          4,
          100,
          200,
        );
        const asset = new DocumentAssetRepository(db).create({
          id: "asset-1",
          documentId: first.document.id,
          name: "original 文件.png",
          mime: "image/png",
          digest: "a".repeat(64),
          size: 100,
          width: 2,
          height: 2,
          alt: "Original image",
          createdAt: 123,
        });
        const placements = new DocumentPlacementRepository(db);
        const placement = placements.insert(
          {
            id: "placement-1",
            projectId: "project-1",
            documentId: first.document.id,
            spaceId: publication.id,
            path: "guides/original.md",
            locale: "en",
            revisionId: first.revision.id,
            metadata: { title: "Site title", custom_topic: "Historical custom value" },
            version: 1,
            createdAt: 100,
            updatedAt: 100,
            deletedAt: null,
          },
          "original-author",
        );
        placements.update({ ...placement, path: "guides/renamed.md" }, 1, "editor");
        const removed = placements.remove(placement.id, 2, "reviewer"),
          history = placements.history(placement.id).reverse();
        const nodes = [
          { documentId: first.document.id, parentId: null, position: 0 },
          { documentId: translated.document.id, parentId: first.document.id, position: 0 },
          { documentId: retired.document.id, parentId: null, position: 1 },
        ];
        if (navigation === 2) {
          const tree = new DocumentNavigationRepository(db);
          tree.initialize(library.id, nodes);
          tree.origin(library.id, "guides", first.document.id);
          tree.recordOperation(library.id, "provider:original-user", "retire", "b".repeat(64), retired.document.id, {
            id: "retire",
            documentId: retired.document.id,
            affectedDocumentIds: [retired.document.id],
            treeVersion: 2,
            restoredToRoot: false,
          });
          tree.retire(library.id, [retired.document.id], "retire");
          tree.bump(library.id, 1);
        } else if (navigation === 1) {
          // Reproduce the original schema directly; never run its mutating constructor in the read-only importer.
          db.exec(`CREATE TABLE document_navigation_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
        INSERT INTO document_navigation_schema VALUES(1,1);
        CREATE TABLE document_tree_versions(spaceId TEXT PRIMARY KEY,version INTEGER NOT NULL);
        CREATE TABLE document_tree_nodes(documentId TEXT PRIMARY KEY,spaceId TEXT NOT NULL,parentId TEXT,position INTEGER NOT NULL);
        CREATE TABLE document_tree_operations(id TEXT PRIMARY KEY,spaceId TEXT NOT NULL,owner TEXT NOT NULL,request TEXT NOT NULL,documentId TEXT NOT NULL,createdAt INTEGER NOT NULL);
        CREATE TABLE document_tree_trash(documentId TEXT PRIMARY KEY,operationId TEXT NOT NULL);`);
          db.query("INSERT INTO document_tree_versions VALUES(?,?)").run(library.id, 8);
          for (const node of nodes)
            db.query("INSERT INTO document_tree_nodes VALUES(?,?,?,?)").run(
              node.documentId,
              library.id,
              node.parentId,
              node.position,
            );
          db.query("INSERT INTO document_tree_operations VALUES(?,?,?,?,?,?)").run(
            "retire",
            library.id,
            "provider:old-user",
            "old-request",
            retired.document.id,
            456,
          );
          db.query("INSERT INTO document_tree_trash VALUES(?,?)").run(retired.document.id, "retire");
          db.query("INSERT INTO document_trash VALUES(?,?)").run(retired.document.id, 457);
        }
        const expectedSpaces = [spaces.get(library.id), spaces.get(publication.id)].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        return {
          library,
          first,
          translated,
          retired,
          profile,
          asset,
          history,
          removed,
          nodes,
          expectedSpaces,
        };
      })
      .immediate();
    db.close();
    return { root, path, ...data, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    db.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
