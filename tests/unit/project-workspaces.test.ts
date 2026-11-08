import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import { ProjectWorkspaceService } from "../../src/server/projects/workspaces/service.js";
import { ProjectWorkspaceRepository } from "../../src/server/projects/workspaces/repository.js";
import { ProjectWorkspaceDirectory } from "../../src/server/projects/workspaces/directory.js";
import { ProjectDirectoryPolicy } from "../../src/server/projects/directory-policy.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-managed-workspace-")),
    path = join(root, "catalog.sqlite"),
    workspaces = join(root, "projects"),
    catalog = new ProjectCatalog(path);
  return {
    root,
    path,
    workspaces,
    catalog,
    service: new ProjectWorkspaceService(catalog, workspaces),
    close: async () => {
      catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const details = { name: "Managed project", code: "managed-project", description: "Project workspace" };
test("project creation owns a real code folder, retries once and locks the code without locking the name", async () => {
  const f = await fixture();
  try {
    const created = await f.service.create(details, 0, "create-1"),
      project = created.projects[0]!;
    expect(project.workspace).toEqual({ path: join(f.workspaces, details.code), state: "ready" });
    expect((await stat(project.workspace!.path)).isDirectory()).toBe(true);
    const marker = JSON.parse(await readFile(join(project.workspace!.path, ".panda-workspace.json"), "utf8"));
    expect(marker.projectId).toBe(project.id);
    const renamed = f.catalog.save({ ...details, id: project.id, name: "Renamed project" }, created.revision);
    expect((await f.service.create(details, 0, "create-1")).projects[0]!.name).toBe("Renamed project");
    expect(f.catalog.snapshot().projects).toHaveLength(1);
    expect(f.catalog.snapshot().revision).toBe(renamed.revision);
    expect(() => f.catalog.save({ ...details, id: project.id, code: "different-code" }, renamed.revision)).toThrow();
    await expect(
      f.service.create({ ...details, code: "another-code" }, renamed.revision, "create-1"),
    ).rejects.toThrow();
    expect(await f.service.ensure(project.id)).toEqual(project.workspace!);
  } finally {
    await f.close();
  }
});

test("workspace preparation preserves unknown directories, symlinks and externally removed ready folders", async () => {
  const f = await fixture();
  try {
    const target = join(f.workspaces, details.code),
      outside = join(f.root, "outside");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "existing.txt"), "Unrelated content");
    await expect(f.service.create(details, 0, "unknown")).rejects.toThrow();
    expect(f.catalog.snapshot().projects).toEqual([]);
    expect(await readFile(join(target, "existing.txt"), "utf8")).toBe("Unrelated content");
    await mkdir(outside);
    await symlink(outside, join(f.workspaces, "symlink-code"));
    await expect(f.service.create({ ...details, code: "symlink-code" }, 0, "symlink")).rejects.toThrow();
    const created = await f.service.create({ ...details, code: "owned-code" }, 0, "owned"),
      project = created.projects[0]!;
    await rm(project.workspace!.path, { recursive: true });
    await expect(f.service.ensure(project.id)).rejects.toThrow();
    await expect(stat(project.workspace!.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("a reserved workspace resumes after restart, keeps existing files and refuses an unconfigured host-engine root", async () => {
  const f = await fixture();
  try {
    const first = f.catalog.save(details, 0),
      project = first.projects[0]!,
      repo = new ProjectWorkspaceRepository(f.catalog.db),
      binding = repo.reserve(project, f.workspaces);
    await new ProjectWorkspaceDirectory(f.workspaces).prepare(binding);
    await writeFile(join(binding.path, "preserved.txt"), "Saved before metadata acknowledgement");
    const reopened = new ProjectCatalog(f.path);
    try {
      const service = new ProjectWorkspaceService(reopened, f.workspaces);
      expect((await service.ensure(project.id)).state).toBe("ready");
      expect(reopened.project(project.id).workspace.path).toBe(binding.path);
      expect(await readFile(join(binding.path, "preserved.txt"), "utf8")).toBe("Saved before metadata acknowledgement");
    } finally {
      reopened.close();
    }
    const unavailable = new ProjectWorkspaceService(f.catalog, join(f.root, "not-shared"), false);
    await expect(
      unavailable.create({ ...details, code: "unconfigured" }, f.catalog.revision(), "no-root"),
    ).rejects.toThrow();
    expect(f.catalog.snapshot().projects).toHaveLength(1);
    await expect(stat(join(f.root, "not-shared"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("restricted browser visibility filters roots, history, replies and native approvals while default mode remains compatible", async () => {
  const f = await fixture();
  try {
    await mkdir(f.workspaces);
    const inside = join(f.workspaces, "inside"),
      outside = join(f.root, "outside");
    await mkdir(inside);
    await mkdir(outside);
    await symlink(outside, join(f.workspaces, "escape"));
    const policy = new ProjectDirectoryPolicy(f.workspaces, false),
      a = { id: "inside", cwd: inside },
      b = { id: "outside", cwd: outside };
    expect(policy.allowsPath(inside)).toBe(true);
    expect(policy.allowsPath(outside)).toBe(false);
    expect(policy.allowsPath(join(f.workspaces, "escape"))).toBe(false);
    expect(await policy.list("thread/list", { data: [a, b], nextCursor: "next" }, async () => b)).toEqual({
      data: [a],
      nextCursor: "next",
    });
    await expect(policy.assertRequest("thread/read", { threadId: b.id }, {}, async () => b)).rejects.toThrow();
    expect(
      policy.envelope({
        id: "outside-approval",
        method: "item/commandExecution/requestApproval",
        params: { threadId: b.id },
      }),
    ).toBe(false);
    expect(
      policy.envelope({
        id: "inside-approval",
        method: "item/commandExecution/requestApproval",
        params: { threadId: a.id },
      }),
    ).toBe(true);
    expect(policy.envelope({ method: "serverRequest/resolved", params: { requestId: "inside-approval" } })).toBe(true);
    expect(policy.envelope({ method: "serverRequest/resolved", params: { requestId: "outside-approval" } })).toBe(
      false,
    );
    const goal = (threadId: string) => ({
      type: "engine/notification",
      payload: { method: "goal/status/changed", params: { threadId, objective: "Private goal" } },
    });
    expect(policy.event(goal(b.id))).toBeNull();
    expect(policy.event(goal(a.id))).toEqual(goal(a.id));
    expect(
      policy.visibility({ revision: 1, hiddenProjects: { [inside]: { hiddenAt: 1 }, [outside]: { hiddenAt: 1 } } })
        .hiddenProjects,
    ).toEqual({ [inside]: { hiddenAt: 1 } });
    const permissive = new ProjectDirectoryPolicy(f.workspaces, true);
    expect(permissive.allowsPath(outside)).toBe(true);
    expect(await permissive.list("thread/list", { data: [a, b] }, async () => b)).toEqual({ data: [a, b] });
  } finally {
    await f.close();
  }
});
