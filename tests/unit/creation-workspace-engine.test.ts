import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolatedApplicationEngines } from "../../src/server/engines/application-tools/factory.js";
import type { CodexTransportFactory } from "../../src/server/engines/codex-transport.js";
import type { ApplicationRunCallbacks } from "../../src/shared/engine/application-tools.js";
test("application creation retains only its verified persistent directory; ordinary runs still clean scratch and keep read-only thread policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "creation-workspace-engine-")),
    scratchRoot = join(root, "scratch"),
    workspaceRoot = join(root, "workspaces"),
    cwd = join(workspaceRoot, "owned");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "requirements.md"), "Retained source\n");
  const requests: { method: string; params?: Record<string, unknown> }[] = [],
    cwdSeen: string[] = [];
  let connections = 0;
  const factory: CodexTransportFactory = (options) => {
      connections++;
      cwdSeen.push(options.defaultCwd);
      let closed = false;
      return {
        get connected() {
          return !closed;
        },
        async request(method, params) {
          requests.push({ method, params });
          if (method === "thread/start") return { thread: { id: "owned-session" } };
          if (method === "turn/start") {
            setTimeout(
              () =>
                options.onMessage({
                  method: "turn/completed",
                  params: { threadId: "owned-session", turn: { id: "owned-run", status: "completed" } },
                }),
              1,
            );
            return { turn: { id: "owned-run" } };
          }
          return {};
        },
        sendRaw() {},
        start() {},
        terminate() {
          closed = true;
        },
        cancelRestart() {},
        rejectPending() {},
        fullyStopped: () => closed,
      };
    },
    engine = isolatedApplicationEngines(
      {
        connection: { mode: "shared", socketPath: "/isolated/test.sock" },
        scratchRoot,
        workspaceRoot,
        version: "test",
        engineId: "codex",
        purpose: "creation",
      },
      factory,
    ).select({ engineId: "codex" }),
    input = {
      prompt: "Write the document",
      instructions: "Use application tools",
      tools: [{ name: "panda_documents_create", description: "Save", inputSchema: { type: "object" } }],
    },
    base: ApplicationRunCallbacks = {
      signal: new AbortController().signal,
      started() {},
      call: async () => ({ success: true, text: "{}" }),
    };
  try {
    await engine.run(input, { ...base, directory: { path: cwd, verify: async () => {} } });
    expect(cwdSeen[0]).toBe(cwd);
    expect(await readFile(join(cwd, "requirements.md"), "utf8")).toBe("Retained source\n");
    const policy = requests.find((r) => r.method === "thread/start")!.params!;
    expect(policy.cwd).toBe(cwd);
    expect(policy.sandbox).toBe("read-only");
    expect(policy.approvalPolicy).toBe("never");
    expect(policy.ephemeral).toBe(true);
    await engine.run(input, base);
    expect(cwdSeen[1]!.startsWith(scratchRoot + "/run-")).toBe(true);
    expect(await readdir(scratchRoot)).toEqual([]);
    await expect(engine.run(input, { ...base, directory: { path: root, verify: async () => {} } })).rejects.toThrow(
      "workspace unavailable",
    );
    await symlink(cwd, join(workspaceRoot, "alias"));
    await expect(
      engine.run(input, { ...base, directory: { path: join(workspaceRoot, "alias"), verify: async () => {} } }),
    ).rejects.toThrow("workspace unavailable");
    await expect(
      engine.run(input, {
        ...base,
        directory: {
          path: cwd,
          verify: async () => {
            throw Error("Access revoked");
          },
        },
      }),
    ).rejects.toThrow("Access revoked");
    expect(connections).toBe(2);
    expect(await readFile(join(cwd, "requirements.md"), "utf8")).toBe("Retained source\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
