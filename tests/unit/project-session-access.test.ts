import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectDirectoryPolicy } from "../../src/server/projects/directory-policy.js";
import { ProjectSessionAccess } from "../../src/server/projects/session-access.js";
import { validSessionReference } from "../../src/shared/engine/session-reference.js";
import { createTemporaryDirectory } from "../support/temporary-directory.js";
const one = "harness:00000000-0000-4000-8000-000000000001";
const two = "harness:00000000-0000-4000-8000-000000000002";

test("public session references admit managed UUIDs without opening arbitrary namespaces", () => {
  for (const id of [one, "native-one", "NATIVE_2"]) expect(validSessionReference(id)).toBe(true);
  for (const id of [
    "harness:../../secret",
    "harness:invalid",
    "harness%3Aid",
    "other:00000000-0000-4000-8000-000000000001",
    "",
    null,
  ])
    expect(validSessionReference(id)).toBe(false);
});
test("mixed native and managed associations persist atomically and broadcasts omit private conversations", async () => {
  const root = createTemporaryDirectory("panda-project-managed-", { preferMemory: true });
  const db = new ProjectCatalog(join(root, "projects.sqlite"));
  try {
    for (const name of ["native", "alice", "bob"]) mkdirSync(join(root, name));
    const initial = db.save({ name: "One", code: "one" }, 0),
      project = initial.projects[0]!;
    const native = { id: "native-one", name: "Native", cwd: join(root, "native") },
      alice = { id: one, name: "Alice private", cwd: join(root, "alice") },
      bob = { id: two, name: "Bob private", cwd: join(root, "bob") };
    const saved = db.assign(project.id, [native, alice, bob], initial.revision);
    expect(saved.assignments).toHaveLength(3);
    for (const external of [true, false]) {
      const policy = new ProjectDirectoryPolicy(root, external);
      const access = new ProjectSessionAccess<string>({
        policy,
        native: async () => native,
        managed: {
          list: async (owner) => (owner === "alice" ? [alice] : [bob]),
          get: async (owner, id) => {
            if (owner === "alice" && id === one.slice(8)) return alice;
            throw Error("Not found");
          },
        },
      });
      const broadcast = policy.snapshot(saved);
      expect(broadcast.reloadRequired).toBe(true);
      expect(broadcast.assignments.map((session) => session.id)).toEqual([native.id]);
      expect(JSON.stringify(policy.event({ type: "project-catalog/changed", ...saved }))).not.toContain("Bob private");
      const scoped = await access.snapshot("alice", saved);
      expect(scoped).not.toHaveProperty("reloadRequired");
      expect(scoped.assignments.map((session) => session.id).sort()).toEqual([one, native.id].sort());
      expect(await access.get("alice", one)).toEqual(alice);
      await expect(access.get("alice", two)).rejects.toThrow("Not found");
    }
    expect(() => db.assign(project.id, [{ id: "other:invalid" }], saved.revision)).toThrow();
    expect(db.snapshot().revision).toBe(saved.revision);
    expect(db.snapshot().assignments).toHaveLength(3);
    expect(() => db.assign(null, [alice], saved.revision)).toThrow();
    expect(db.sessionProject(one)).toBe(project.id);
    const removed = db.forgetSession(one)!;
    expect(removed.assignments.map((session) => session.id)).not.toContain(one);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
