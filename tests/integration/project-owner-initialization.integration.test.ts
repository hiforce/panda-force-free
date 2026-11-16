import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import { DocumentError } from "../../src/server/documents/errors.js";

test("an overlapping missing-source read cannot prevent explicit owned-project initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-owner-initialize-"));
  try {
    const projects = new DocumentFileProjects(root, () => {}),
      read = projects.view("project-1", async () => true),
      create = projects.initialize("project-1", async (project) => project.owned.projectId),
      repeated = projects.initialize("project-1", async (project) => project.owned.projectId),
      results = await Promise.allSettled([read, create, repeated]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[1]).toEqual({ status: "fulfilled", value: "project-1" });
    expect(results[2]).toEqual({ status: "fulfilled", value: "project-1" });
    expect(await projects.view("project-1", async () => true)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("initialization after a read miss rechecks revoked authorization before creating any project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-owner-revoked-"));
  try {
    let checks = 0;
    const projects = new DocumentFileProjects(root, () => {
        if (++checks >= 3) throw new DocumentError("notFound", 404);
      }),
      read = projects.view("project-1", async () => true),
      create = projects.initialize("project-1", async () => true),
      result = await Promise.allSettled([read, create]);
    expect(result.map((row) => row.status)).toEqual(["rejected", "rejected"]);
    expect(checks).toBe(3);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("an overlapping initialization never adopts an existing unowned directory after a read failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-owner-unowned-"));
  try {
    const directory = join(root, "projects", "project-1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "original.txt"), "Preserve");
    const projects = new DocumentFileProjects(root, () => {}),
      read = projects.view("project-1", async () => true),
      create = projects.initialize("project-1", async () => true),
      result = await Promise.allSettled([read, create]);
    expect(result.map((row) => row.status)).toEqual(["rejected", "rejected"]);
    expect(await readFile(join(directory, "original.txt"), "utf8")).toBe("Preserve");
    expect(await readdir(directory)).toEqual(["original.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
