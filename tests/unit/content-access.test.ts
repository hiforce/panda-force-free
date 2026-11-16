import { expect, test } from "bun:test";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ContentScopeAccess } from "../../src/server/content-access/access.js";
import { ContentAccessStore } from "../../src/server/content-access/storage/grants.js";
import { contentAccessPolicy } from "../../src/server/content-access/integration/config.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const admin = "a".repeat(64),
  alice = "b".repeat(64),
  bob = "c".repeat(64);
test("restricted membership grants project reads independently of contribution and personal ownership", async () => {
  const catalog = new ProjectCatalog(":memory:");
  try {
    const p = catalog.save({ code: "first-project", name: "First" }, 0).projects[0]!,
      other = catalog.save({ code: "second-project", name: "Other" }, 1).projects.find((item) => item.id !== p.id)!,
      store = new ContentAccessStore(catalog.db),
      access = new ContentScopeAccess({ mode: "restricted", administrators: new Set() }, store, () => admin);
    await expect(access.require(alice, p.id)).rejects.toThrow("notFound");
    store.set(admin, p.id, alice, "reader", 0, 1000);
    await expect(access.require(alice, p.id)).resolves.toBeUndefined();
    await expect(access.require(alice, p.id, "contribute")).rejects.toThrow("notFound");
    await expect(access.require(bob, p.id)).rejects.toThrow("notFound");
    expect((await access.view(alice, [p, other])).projects).toEqual([{ id: p.id, name: p.name, role: "reader" }]);
    await expect(access.require(alice, "personal", "contribute")).resolves.toBeUndefined();
    store.set(admin, p.id, alice, "contributor", 1, 1001);
    await expect(access.require(alice, p.id, "contribute")).resolves.toBeUndefined();
    store.set(admin, p.id, alice, null, 2, 1002);
    await expect(access.require(alice, p.id)).rejects.toThrow("notFound");
    expect((await access.view(admin, [p, other])).projects).toHaveLength(2);
    expect(catalog.revision()).toBe(2);
    expect(catalog.db.query("SELECT COUNT(*) n FROM content_access_changes").get()).toEqual({ n: 3 });
    await expect(access.require("not-an-authenticated-owner", p.id)).rejects.toThrow("invalidInput");
  } finally {
    catalog.close();
  }
});
test("shared installations can explicitly block a project and grant mutations cannot silently overwrite a newer revision", async () => {
  const catalog = new ProjectCatalog(":memory:");
  try {
    const project = catalog.save({ code: "shared-project", name: "Shared" }, 0).projects[0]!,
      store = new ContentAccessStore(catalog.db),
      access = new ContentScopeAccess({ mode: "shared", administrators: new Set([admin]) }, store, () => null);
    await expect(access.require(alice, project.id, "contribute")).resolves.toBeUndefined();
    store.set(admin, project.id, alice, "blocked", 0, 1000);
    await expect(access.require(alice, project.id)).rejects.toThrow("notFound");
    expect(() => store.set(admin, project.id, alice, "contributor", 0, 1001)).toThrow("conflict");
    expect(store.role(alice, project.id)).toBe("blocked");
    expect(store.revision()).toBe(1);
    expect(catalog.db.query("SELECT COUNT(*) n FROM content_access_changes").get()).toEqual({ n: 1 });
    store.set(admin, project.id, alice, null, 1, 1002);
    await expect(access.require(alice, project.id, "contribute")).resolves.toBeUndefined();
  } finally {
    catalog.close();
  }
});
test("external administrator bootstrap and the shared-access switch come only from a closed trusted policy file", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-content-policy-")),
    path = join(root, "policy.json");
  try {
    expect(contentAccessPolicy(root, {})).toMatchObject({ mode: "restricted" });
    expect(() => contentAccessPolicy(root, { PANDA_FORCE_CONTENT_ACCESS_CONFIG_FILE: path })).toThrow("unavailable");
    await writeFile(path, JSON.stringify({ schema: 1, mode: "restricted", administrators: [admin] }));
    expect(contentAccessPolicy(root, { PANDA_FORCE_CONTENT_ACCESS_CONFIG_FILE: path }).administrators.has(admin)).toBe(
      true,
    );
    for (const value of [
      { schema: 1, mode: "public", administrators: [] },
      { schema: 1, mode: "shared", administrators: [admin, admin] },
      { schema: 1, mode: "shared", administrators: ["admin"] },
      { schema: 1, mode: "shared", administrators: [], grants: [{ owner: alice, project: "all" }] },
    ]) {
      await writeFile(path, JSON.stringify(value));
      expect(() => contentAccessPolicy(root, { PANDA_FORCE_CONTENT_ACCESS_CONFIG_FILE: path })).toThrow("unavailable");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
