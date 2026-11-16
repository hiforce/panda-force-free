import { expect, test } from "bun:test";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDocumentStorage } from "../../src/server/projects/document-storage.js";

test("project authority binding participates in catalog creation rollback and survives reopening the selector", () => {
  const catalog = new ProjectCatalog(":memory:"),
    storage = new ProjectDocumentStorage(catalog.db);
  try {
    expect(() =>
      catalog.atomic(() => {
        const result = catalog.save({ name: "Preview", code: "preview" }, 0);
        storage.bindFiles(result.projects[0]!.id);
        throw Error("Rollback");
      }),
    ).toThrow();
    expect(catalog.snapshot().projects).toHaveLength(0);
    expect(catalog.db.query("SELECT * FROM project_document_storage").all()).toHaveLength(0);
    const project = catalog.atomic(() => {
      const result = catalog.save({ name: "Preview", code: "preview" }, 0),
        created = result.projects[0]!;
      storage.bindFiles(created.id);
      return created;
    });
    expect(new ProjectDocumentStorage(catalog.db).files(project.id)).toBe(true);
    expect(storage.files("missing")).toBe(false);
    expect(() => storage.bindFiles("missing")).toThrow();
  } finally {
    catalog.db.close();
  }
});
