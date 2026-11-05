import { expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { createTemporaryDirectory } from "../support/temporary-directory.js";

test("projects are explicit entities and associations survive restart without changing session directories", () => {
  const root = createTemporaryDirectory("panda-projects-", { preferMemory: true }),
    path = join(root, "data", "projects.sqlite");
  let db = new ProjectCatalog(path);
  try {
    let s = db.save({ name: "商品运营", code: "Prism_Force", description: "两种目录的会话" }, 0);
    const a = s.projects[0];
    expect(a.code).toBe("prism_force");
    expect(a).not.toHaveProperty("cwd");
    s = db.save({ name: "另一项目", code: "second" }, s.revision);
    const b = s.projects.find((p) => p.id !== a.id)!;
    s = db.assign(
      a.id,
      [
        { id: "native-one", name: "A", cwd: "/shared/folder" },
        { id: "native-two", name: "B", cwd: "/different/folder" },
      ],
      s.revision,
    );
    s = db.assign(b.id, [{ id: "native-three", name: "C", cwd: "/shared/folder" }], s.revision);
    expect(s.assignments.filter((x) => x.projectId === a.id)).toHaveLength(2);
    expect(s.assignments.find((x) => x.id === "native-three")?.projectId).toBe(b.id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "data")).mode & 0o777).toBe(0o700);
    db.close();
    db = new ProjectCatalog(path);
    expect(db.snapshot()).toEqual(s);
    s = db.assign(b.id, [{ id: "native-one", name: "A", cwd: "/shared/folder" }], s.revision);
    expect(s.assignments.filter((x) => x.id === "native-one")).toHaveLength(1);
    expect(s.assignments.find((x) => x.id === "native-one")?.cwd).toBe("/shared/folder");
    s = db.assign(null, [{ id: "native-one" }], s.revision);
    expect(s.assignments.find((x) => x.id === "native-one")).toBeUndefined();
    expect(s.projects).toHaveLength(2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("case-insensitive codes, revisions and atomic batches prevent conflicting writes", () => {
  const root = createTemporaryDirectory("panda-project-revisions-", { preferMemory: true }),
    path = join(root, "projects.sqlite");
  const a = new ProjectCatalog(path),
    b = new ProjectCatalog(path);
  try {
    const first = a.save({ name: "First", code: "ALPHA" }, 0);
    expect(() => b.save({ name: "Stale", code: "beta" }, 0)).toThrow("another window");
    expect(() => b.save({ name: "Duplicate", code: "Alpha" }, first.revision)).toThrow("already exists");
    expect(() => a.assign("missing", [{ id: "one" }], first.revision)).toThrow("Project not found");
    expect(() => a.assign(first.projects[0].id, [{ id: "one" }, { id: "one" }], first.revision)).toThrow();
    expect(a.snapshot()).toEqual(first);
    const renamed = b.save({ ...first.projects[0], name: "Renamed", code: "new-code" }, first.revision);
    expect(renamed.projects[0].id).toBe(first.projects[0].id);
    expect(renamed.projects[0].code).toBe("new-code");
    for (const fields of [
      { name: "", code: "valid" },
      { name: "Name", code: "../bad" },
      { name: "Name", code: "a" },
      { name: "Name", code: "valid", description: "x".repeat(2001) },
    ])
      expect(() => a.save(fields, renamed.revision)).toThrow();
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
