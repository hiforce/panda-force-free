import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAppFixture } from "../support/app-fixture.mjs";

test("project HTTP creation persists code directories and native sessions use server-bound cwd without waiting for catalog events", async () => {
  const f = await createAppFixture();
  const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(f.base + path, {
      method,
      headers: { ...f.headers, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    let snapshot = (await call("/api/projects")).data;
    const creation = {
      name: "Managed root",
      code: "managed-root",
      description: "A real workspace",
      operationId: "creation-1",
      revision: snapshot.revision,
    };
    const created = await call("/api/projects", creation);
    expect(created.status).toBe(201);
    snapshot = created.data;
    const project = snapshot.projects[0],
      path = join(f.dir, "panda-state", "projects", "managed-root");
    expect(project.workspace).toEqual({ path, state: "ready" });
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(path, ".panda-workspace.json"), "utf8")).projectId).toBe(project.id);
    expect((await call("/api/projects", creation)).data.projects).toHaveLength(1);
    const started = await call("/api/rpc", {
      type: "rpc",
      id: "new",
      method: "thread/start",
      params: { cwd: f.beta, pandaProjectId: project.id },
    });
    const result = started.data.result;
    expect(result.thread.cwd).toBe(path);
    expect(result.pandaProjectId).toBe(project.id);
    expect(result.pandaProjectCatalog.assignments.find((row: any) => row.id === result.thread.id).projectId).toBe(
      project.id,
    );
    const native = f.calls().find((row: any) => row.method === "thread/start");
    expect(native.params.cwd).toBe(path);
    expect(native.params).not.toHaveProperty("pandaProjectId");
    snapshot = (await call("/api/projects")).data;
    const linked = await call("/api/projects/assign", {
      projectId: project.id,
      sessionIds: ["old-alpha"],
      revision: snapshot.revision,
    });
    expect(linked.data.assignments.find((row: any) => row.id === "old-alpha").cwd).toBe(f.alpha);
    const renamed = await call(
      "/api/projects",
      { id: project.id, name: "New name", code: project.code, description: "Updated", revision: linked.data.revision },
      "PATCH",
    );
    expect(renamed.status).toBe(200);
    expect(
      (
        await call(
          "/api/projects",
          { id: project.id, name: "New name", code: "moved-code", revision: renamed.data.revision },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    await f.stop();
    await f.start();
    expect((await call("/api/projects")).data.projects[0].workspace.path).toBe(path);
  } finally {
    await f.dispose();
  }
}, 30000);

test("restricted installations hide external histories and file directories through HTTP and browser RPC", async () => {
  const f = await createAppFixture({ extraEnvironment: () => ({ PANDA_FORCE_ALLOW_EXTERNAL_DIRECTORIES: "false" }) });
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(f.base + path, {
      method: body ? "POST" : "GET",
      headers: { ...f.headers, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const config = (await call("/api/config")).data;
    expect(config.allowExternalDirectories).toBe(false);
    expect(config.browseRoots).toEqual([join(f.dir, "panda-state", "projects")]);
    expect((await call("/api/projects/history")).data.sessions).toEqual([]);
    const list = await call("/api/rpc", { type: "rpc", id: "list", method: "thread/list", params: {} });
    expect(list.data.result.data.every((row: any) => row.cwd?.startsWith(config.projectWorkspaceRoot))).toBe(true);
    const history = await call("/api/rpc", {
      type: "rpc",
      id: "outside",
      method: "thread/read",
      params: { threadId: "old-alpha" },
    });
    expect(history.data.type).toBe("rpc/error");
    expect(JSON.stringify(history.data)).not.toContain(f.alpha);
    const files = await call("/api/workspace/tree?cwd=" + encodeURIComponent(f.alpha));
    expect(files.status).toBeGreaterThanOrEqual(400);
    const snapshot = (await call("/api/projects")).data;
    const created = await call("/api/projects", {
      name: "Inside",
      code: "inside-project",
      revision: snapshot.revision,
    });
    expect(created.status).toBe(201);
    const started = await call("/api/rpc", {
      type: "rpc",
      id: "inside",
      method: "thread/start",
      params: { cwd: f.beta, pandaProjectId: created.data.projects[0].id },
    });
    expect(started.data.result.thread.cwd).toBe(join(config.projectWorkspaceRoot, "inside-project"));
    const inside = await call("/api/rpc", {
      type: "rpc",
      id: "inside-read",
      method: "thread/read",
      params: { threadId: started.data.result.thread.id, includeTurns: true },
    });
    expect(inside.data.type).toBe("rpc/result");
    await writeFile(
      join(f.dir, "history.jsonl"),
      [
        { session_id: "old-alpha", text: "External prompt" },
        { session_id: started.data.result.thread.id, text: "Inside prompt" },
        { text: "Unscoped prompt" },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    expect((await call("/api/composer/history")).data.entries).toEqual([{ text: "Inside prompt" }]);
    expect((await call("/api/folders")).data.path).toBe(config.projectWorkspaceRoot);
    const upload = await fetch(f.base + "/api/attachments?name=owned.txt", {
      method: "POST",
      headers: { ...f.headers, "content-type": "text/plain" },
      body: "Owned attachment",
    });
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()).attachment;
    const download = await fetch(f.base + "/api/files/download?path=" + encodeURIComponent(attachment.path), {
      headers: f.headers,
    });
    expect(await download.text()).toBe("Owned attachment");
    expect(
      (await call("/api/workspace/tree?cwd=" + encodeURIComponent(join(f.dir, "panda-state", "attachments")))).status,
    ).toBeGreaterThanOrEqual(400);
    const link = await call("/api/projects/assign", {
      projectId: created.data.projects[0].id,
      sessionIds: ["old-alpha"],
      revision: (await call("/api/projects")).data.revision,
    });
    expect(link.status).toBe(404);
  } finally {
    await f.dispose();
  }
}, 30000);
