import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentAccess } from "../../src/server/content-access/integration/feature.js";
import { ContentAccessStore } from "../../src/server/content-access/storage/grants.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";

const admin = "a".repeat(64),
  reader = "b".repeat(64),
  stranger = "c".repeat(64);
test("explicit legacy authority preserves membership and never grants native file access", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-legacy-access-")),
    db = new Database(":memory:");
  try {
    const existing = (id: string) => {
      if (id !== "legacy-project") throw new DocumentError("notFound", 404);
    };
    const options = {
      db,
      stateRoot: root,
      projects: () => [],
      requireProject: () => {
        throw new DocumentError("notFound", 404);
      },
      documents: new DocumentFileProjects(root, existing),
      localAdministrator: () => admin,
      ownerAllowed: (id: string) => id !== stranger,
      owner: () => admin,
      report: (error: unknown) => {
        throw error;
      },
    };
    const access = createContentAccess({ ...options, requireLegacyProject: existing }, {}),
      grants = new ContentAccessStore(db);
    expect(() => access.requireLegacy(admin, "legacy-project", "contribute")).not.toThrow();
    expect(() => access.require(admin, "legacy-project")).toThrow("notFound");
    expect(() => access.requireLegacy(admin, "missing-project")).toThrow("notFound");
    expect(() => access.requireLegacy(reader, "legacy-project")).toThrow("notFound");
    grants.set(admin, "legacy-project", reader, "reader", 0, 1000);
    expect(() => access.requireLegacy(reader, "legacy-project")).not.toThrow();
    expect(() => access.requireLegacy(reader, "legacy-project", "contribute")).toThrow("notFound");
    expect(() => access.requireLegacy(stranger, "legacy-project")).toThrow("notFound");
    grants.set(admin, "legacy-project", reader, "blocked", 1, 1001);
    expect(() => access.requireLegacy(reader, "legacy-project")).toThrow("notFound");
    expect(() => createContentAccess(options, {}).requireLegacy(admin, "legacy-project")).toThrow("notFound");
    expect(() => access.requireLegacy("invalid", "legacy-project")).toThrow();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
