import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCreationWorkspaces } from "../../src/server/creation/integration/conversation-workspaces.js";
import { openCreationDirectory } from "../../src/server/creation/integration/conversation-directory.js";
import { CreationError, type CreationTaskSpec, type CreationTask } from "../../src/server/creation/contracts.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creation-workspaces-")),
    workspace = join(root, "engine"),
    metadata = join(root, "metadata"),
    tasks = new Map<string, CreationTask>();
  let allowed = true;
  const port = {
      get: async (owner: string, id: string) => {
        const task = tasks.get(id);
        if (!task || task.spec.owner !== owner) throw new CreationError("notFound");
        return task;
      },
    },
    authorize = async () => {
      if (!allowed) throw new CreationError("notFound");
    };
  const add = (previous?: CreationTaskSpec, owner = "owner", project = "personal") => {
    const spec: CreationTaskSpec = {
      schema: 1,
      id: randomUUID(),
      owner,
      projectId: project,
      operationId: randomUUID(),
      kind: "document",
      target: { parentId: null, treeVersion: 0, locale: "en" },
      inputDigest: "0".repeat(64),
      skillCaptureId: null,
      ...(previous ? { previousTaskId: previous.id } : {}),
    };
    tasks.set(spec.id, {
      spec,
      state: "queued",
      generation: 0,
      attempts: 0,
      cancelRequested: false,
      outputDigest: null,
      artifact: null,
      failure: null,
      createdAt: 1,
      updatedAt: 1,
    });
    return spec;
  };
  return {
    root,
    workspace,
    metadata,
    tasks,
    port,
    authorize,
    add,
    allow: (value: boolean) => {
      allowed = value;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("writing rounds retain a persistent original conversation directory across restarts and applications stay separate", async () => {
  const f = await fixture();
  try {
    const first = f.add(),
      second = f.add(first),
      workspaces = new FileCreationWorkspaces(f.workspace, f.metadata, f.port, f.authorize);
    expect(await workspaces.lookup("owner", first.id)).toBeNull();
    await expect(access(f.workspace)).rejects.toMatchObject({ code: "ENOENT" });
    const original = await workspaces.open(first),
      next = await new FileCreationWorkspaces(f.workspace, f.metadata, f.port, f.authorize).open(second);
    expect(next.path).toBe(original.path);
    expect(next.conversationId).toBe(first.id);
    await next.verify();
    expect((await workspaces.lookup("owner", second.id))?.path).toBe(original.path);
    const third = f.add(second),
      otherApplication = new FileCreationWorkspaces(
        f.workspace,
        join(f.root, "other-app-metadata"),
        f.port,
        f.authorize,
      ),
      other = await otherApplication.open(third);
    expect(other.path).not.toBe(original.path);
    expect(await readdir(original.path)).toEqual([".panda-creation.json"]);
    expect(await readFile(join(original.path, ".panda-creation.json"), "utf8")).toContain(first.id);
  } finally {
    await f.close();
  }
});
test("authorization is rechecked, and foreign owners or projects cannot borrow a conversation", async () => {
  const f = await fixture();
  try {
    const first = f.add(),
      workspaces = new FileCreationWorkspaces(f.workspace, f.metadata, f.port, f.authorize),
      opened = await workspaces.open(first);
    f.allow(false);
    await expect(opened.verify()).rejects.toThrow("notFound");
    await expect(workspaces.lookup("owner", first.id)).rejects.toThrow("notFound");
    f.allow(true);
    await expect(workspaces.lookup("other", first.id)).rejects.toThrow("notFound");
    await expect(workspaces.open(f.add(first, "owner", "other-project"))).rejects.toThrow("conflict");
    await expect(workspaces.open(f.add(first, "other-owner"))).rejects.toThrow("notFound");
    expect(await readdir(opened.path)).toEqual([".panda-creation.json"]);
  } finally {
    await f.close();
  }
});
test("directory publication converges without adopting foreign empty directories or symlinks", async () => {
  const f = await fixture();
  try {
    await mkdir(f.workspace);
    const [one, two] = await Promise.all([
      openCreationDirectory(f.workspace, "same", { kind: "test" }, true),
      openCreationDirectory(f.workspace, "same", { kind: "test" }, true),
    ]);
    expect(one?.path).toBe(two?.path);
    await one!.verify();
    await two!.verify();
    await mkdir(join(f.workspace, "foreign"));
    await expect(openCreationDirectory(f.workspace, "foreign", { kind: "test" }, true)).rejects.toThrow();
    expect(await readdir(join(f.workspace, "foreign"))).toEqual([]);
    await symlink(one!.path, join(f.workspace, "alias"));
    await expect(openCreationDirectory(f.workspace, "alias", { kind: "test" }, true)).rejects.toThrow();
    await rename(one!.path, one!.path + "-moved");
    await mkdir(one!.path);
    await expect(one!.verify()).rejects.toThrow();
  } finally {
    await f.close();
  }
});
test("late legacy continuation resolves immutable task ancestry and rejects cycles before creating a directory", async () => {
  const f = await fixture();
  try {
    const first = f.add(),
      second = f.add(first),
      third = f.add(second),
      workspaces = new FileCreationWorkspaces(f.workspace, f.metadata, f.port, f.authorize);
    expect((await workspaces.open(third)).conversationId).toBe(first.id);
    const broken = f.add();
    broken.previousTaskId = broken.id;
    await expect(workspaces.open(broken)).rejects.toThrow("conflict");
  } finally {
    await f.close();
  }
});
