import { expect, test } from "bun:test";
import { readFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createAppFixture } from "../support/app-fixture.mjs";
import { buildComposerInput, composerInputKey, composerTextFromInput } from "../../src/client/composer-attachments.js";

test("workspace uploads and generated Unicode downloads survive restart without container-private paths", async () => {
  const f = await createAppFixture();
  const rpc = async (method: string, params: object) => {
    const response = await fetch(f.base + "/api/rpc", {
      method: "POST",
      headers: { ...f.headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "rpc", id: 1, method, params }),
    });
    const reply = await response.json();
    expect(reply.type).toBe("rpc/result");
    return reply.result;
  };
  try {
    const filename = "签字页 空格（表8）.pdf";
    const original = Buffer.from("%PDF-1.4\nOriginal scan bytes\n");
    const upload = await fetch(f.base + "/api/attachments?" + new URLSearchParams({ name: filename, cwd: f.alpha }), {
      method: "POST",
      headers: f.headers,
      body: original,
    });
    expect(upload.status).toBe(201);
    const { attachment } = await upload.json();
    expect(attachment.path).toBe(join(f.alpha, "attachments", "input", attachment.id, filename));
    expect(readFileSync(attachment.path)).toEqual(original);
    const { thread } = await rpc("thread/start", { cwd: f.alpha });
    const input = buildComposerInput("Clean the scan background", [attachment]);
    for (const method of ["turn/start", "turn/steer", "thread/queue/add"]) {
      await rpc(method, { threadId: thread.id, input });
      const call = f
        .calls()
        .filter((row: any) => row.method === method)
        .at(-1);
      expect(composerTextFromInput(call.params.input)).toBe("Clean the scan background");
      expect(composerInputKey(call.params.input)).toBe(composerInputKey(input));
      const context = call.params.input.at(-1).text;
      expect(context).toContain(JSON.stringify(join(f.alpha, "attachments", "work", thread.id)));
      expect(context).toContain(JSON.stringify(join(f.alpha, "attachments", "output", thread.id)));
      const marker = JSON.parse(readFileSync(join(f.alpha, "attachments", ".panda-attachments.json"), "utf8"));
      expect(context).toContain(marker.id);
    }
    const output = join(f.alpha, "attachments", "output", thread.id, "签字页-白底版.pdf");
    const result = Buffer.from("%PDF-1.4\nWhite background result bytes\n");
    const writer = Bun.spawnSync([
      process.execPath,
      "-e",
      "require('fs').writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))",
      output,
      result.toString("base64"),
    ]);
    expect(writer.exitCode).toBe(0);
    const download = () =>
      fetch(f.base + "/api/files/download?" + new URLSearchParams({ path: output }), { headers: f.headers });
    const first = await download();
    expect(first.status).toBe(200);
    expect(first.headers.get("content-disposition")).toContain(encodeURIComponent("签字页-白底版.pdf"));
    expect(Buffer.from(await first.arrayBuffer())).toEqual(result);
    const markerBefore = readFileSync(join(f.alpha, "attachments", ".panda-attachments.json"), "utf8");
    await f.stop();
    await f.start();
    const after = await download();
    expect(after.status).toBe(200);
    expect(Buffer.from(await after.arrayBuffer())).toEqual(result);
    expect(readFileSync(attachment.path)).toEqual(original);
    expect(readFileSync(join(f.alpha, "attachments", ".panda-attachments.json"), "utf8")).toBe(markerBefore);
  } finally {
    await f.dispose();
  }
}, 30000);

test("upload destination uses the managed project or authoritative thread and rejects outside and symlink paths", async () => {
  const f = await createAppFixture();
  const post = async (path: string, body: object) => {
    const response = await fetch(f.base + path, {
      method: "POST",
      headers: { ...f.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, data: await response.json() };
  };
  const upload = (query: Record<string, string>) =>
    fetch(f.base + "/api/attachments?" + new URLSearchParams({ name: "document.txt", ...query }), {
      method: "POST",
      headers: f.headers,
      body: "original",
    });
  try {
    const catalog = await (await fetch(f.base + "/api/projects", { headers: f.headers })).json();
    const created = await post("/api/projects", { name: "Files", code: "files-project", revision: catalog.revision });
    expect(created.response.status).toBe(201);
    const project = created.data.projects[0];
    const managed = await upload({ projectId: project.id, cwd: f.beta });
    expect(managed.status).toBe(201);
    expect((await managed.json()).attachment.path).toContain(join(project.workspace.path, "attachments", "input"));
    const threaded = await upload({ threadId: "old-alpha", cwd: f.beta });
    expect(threaded.status).toBe(201);
    expect((await threaded.json()).attachment.path).toContain(join(f.alpha, "attachments", "input"));
    expect((await upload({ cwd: "/etc" })).status).toBe(400);
    expect((await upload({ threadId: "missing-session", cwd: f.alpha })).status).toBe(400);
    symlinkSync(f.alpha, join(f.beta, "attachments"));
    expect((await upload({ cwd: f.beta })).status).toBe(400);
    const reply = await post("/api/rpc", {
      type: "rpc",
      id: 1,
      method: "turn/start",
      params: { threadId: "old-beta", input: [{ type: "text", text: "Discuss the code" }] },
    });
    expect(reply.data.type).toBe("rpc/result");
    const native = f
      .calls()
      .filter((row: any) => row.method === "turn/start")
      .at(-1);
    expect(native.params.input.at(-1).text).toContain("could not prepare");
    expect(composerTextFromInput(native.params.input)).toBe("Discuss the code");
    expect(existsSync(join(f.beta, "attachments", "output", "old-beta"))).toBe(false);
  } finally {
    await f.dispose();
  }
}, 30000);
