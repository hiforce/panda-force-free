import { describe, test, expect } from "bun:test";
import { CliError } from "../../src/shared/cli/contracts.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { CliCredentials } from "../../src/server/cli/auth/service.js";
import { openCliCredentialStore } from "../../src/server/cli/auth/sqlite.js";
import { executeCliCommand } from "../../src/server/cli/commands.js";
const input = {
  name: "Private agent",
  kind: "claude",
  projects: ["personal", "project-1"],
  capabilities: ["content:read"],
  expiresInDays: 1,
};
describe("registered CLI credentials", () => {
  test("corrupt stored scope data cannot become a partially valid grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "panda-cli-corrupt-")),
      path = join(root, "auth.sqlite");
    const db = openCliCredentialStore(path),
      editor = new Database(path);
    try {
      const service = new CliCredentials(db.store),
        issued = await service.issue("owner-a", "https://panda.example", input, async () => {});
      editor.query("UPDATE cli_keys SET projects=?").run(JSON.stringify("project-1personal"));
      await expect(service.authenticate(issued.registration.clientId, issued.apiKey)).rejects.toThrow("unavailable");
      editor
        .query("UPDATE cli_keys SET projects=?,capabilities=?")
        .run(JSON.stringify(["personal"]), JSON.stringify(["content:read", "server:admin"]));
      await expect(service.authenticate(issued.registration.clientId, issued.apiKey)).rejects.toThrow("unavailable");
    } finally {
      editor.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("revoked and expired registrations do not exhaust the active client quota", async () => {
    const db = openCliCredentialStore(":memory:");
    let now = 1000;
    try {
      const service = new CliCredentials(db.store, () => now);
      for (let index = 0; index < 105; index++) {
        const issued = await service.issue("owner-a", "https://panda.example", input, async () => {});
        await service.revoke("owner-a", issued.registration.clientId);
      }
      for (let index = 0; index < 100; index++)
        await service.issue("owner-a", "https://panda.example", input, async () => {});
      await expect(service.issue("owner-a", "https://panda.example", input, async () => {})).rejects.toThrow("limit");
      now += 86400000;
      const current = await service.issue("owner-a", "https://panda.example", input, async () => {});
      expect((await service.authenticate(current.registration.clientId, current.apiKey)).owner).toBe("owner-a");
    } finally {
      db.close();
    }
  });
  test("durable hash-only keys reject absent, mismatched, expired and revoked clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "panda-cli-key-")),
      path = join(root, "cli.sqlite");
    let now = 1000,
      db = openCliCredentialStore(path);
    try {
      let service = new CliCredentials(db.store, () => now);
      const issued = await service.issue("owner-a", "https://panda.example", input, async () => {}),
        key = issued.apiKey;
      expect((await service.authenticate(issued.registration.clientId, key)).owner).toBe("owner-a");
      for (const invalid of [undefined, "", key + "x", key.slice(0, -1) + (key.endsWith("a") ? "b" : "a")])
        await expect(service.authenticate(issued.registration.clientId, invalid)).rejects.toThrow(
          "authenticationRequired",
        );
      await expect(service.authenticate("other-client", key)).rejects.toThrow("authenticationRequired");
      expect(await service.list("owner-b")).toEqual([]);
      expect(JSON.stringify(await service.list("owner-a"))).not.toContain(key);
      await expect(service.revoke("owner-b", issued.registration.clientId)).rejects.toThrow("notFound");
      db.close();
      expect((await readFile(path)).includes(Buffer.from(key))).toBe(false);
      db = openCliCredentialStore(path);
      service = new CliCredentials(db.store, () => now);
      expect((await service.authenticate(issued.registration.clientId, key)).capabilities).toEqual(["content:read"]);
      now += 86400000;
      await expect(service.authenticate(issued.registration.clientId, key)).rejects.toThrow("authenticationRequired");
      now = 2000;
      await service.revoke("owner-a", issued.registration.clientId);
      await expect(service.authenticate(issued.registration.clientId, key)).rejects.toThrow("authenticationRequired");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("capability and project denial happen before any content adapter runs", async () => {
    const db = openCliCredentialStore(":memory:");
    try {
      const service = new CliCredentials(db.store),
        issued = await service.issue("owner-a", "https://panda.example", input, async () => {}),
        grant = await service.authenticate(issued.registration.clientId, issued.apiKey),
        calls: unknown[] = [],
        commands = {
          execute: async (...args: unknown[]) => {
            calls.push(args);
            return { title: "Private" };
          },
        },
        signal = new AbortController().signal;
      await expect(
        executeCliCommand(
          grant,
          { schema: 1, command: "documents.read", args: { project: "project-2", id: "doc-1" } },
          commands,
          signal,
        ),
      ).rejects.toThrow("forbidden");
      await expect(
        executeCliCommand(
          grant,
          { schema: 1, command: "knowledge.approve", args: { project: "personal", id: "task-1", revision: 1 } },
          commands,
          signal,
        ),
      ).rejects.toThrow("forbidden");
      await expect(
        executeCliCommand(
          grant,
          { schema: 1, command: "thread/read", args: { project: "personal" } },
          commands,
          signal,
        ),
      ).rejects.toThrow("notFound");
      await expect(
        executeCliCommand(
          grant,
          { schema: 1, command: "documents.read", args: { project: "personal", id: "doc-1", owner: "victim" } },
          commands,
          signal,
        ),
      ).rejects.toThrow("invalidInput");
      expect(calls).toHaveLength(0);
      await executeCliCommand(
        grant,
        { schema: 1, command: "documents.read", args: { project: "personal", id: "doc-1" } },
        commands,
        signal,
      );
      expect(calls[0]![0]).toBe("owner-a");
    } finally {
      db.close();
    }
  });
});

test("dynamic project grants use current account access and fixed grants retain their project list", async () => {
  const db = openCliCredentialStore(":memory:");
  try {
    const service = new CliCredentials(db.store);
    const projectAccess = new Set(["first"]);
    const authorize = async (project: string) => {
      if (!projectAccess.has(project)) throw new CliError("forbidden", 403);
    };
    const dynamic = await service.issue(
      "owner-a",
      "https://panda.example",
      {
        ...input,
        projectScope: "allAccessible",
        projects: [],
        capabilities: ["memory:read"],
      },
      authorize,
    );
    const fixed = await service.issue(
      "owner-a",
      "https://panda.example",
      {
        ...input,
        projects: ["first"],
        capabilities: ["memory:read"],
      },
      authorize,
    );
    const access = async (issued: typeof dynamic, project: string) =>
      executeCliCommand(
        await service.authenticate(issued.registration.clientId, issued.apiKey),
        { schema: 1, command: "memory.search", args: { project } },
        {
          async execute(owner, command, args) {
            expect(owner).toBe("owner-a");
            expect(command).toBe("memory.search");
            await authorize(String(args.project));
            return { entries: [] };
          },
        },
        new AbortController().signal,
      );
    await expect(access(dynamic, "new-project")).rejects.toThrow("forbidden");
    projectAccess.add("new-project");
    await expect(access(dynamic, "new-project")).resolves.toEqual({ entries: [] });
    await expect(access(fixed, "new-project")).rejects.toThrow("forbidden");
    projectAccess.delete("new-project");
    await expect(access(dynamic, "new-project")).rejects.toThrow("forbidden");
    expect((await service.list("owner-a")).find(({ id }) => id === dynamic.registration.clientId)?.projectScope).toBe(
      "allAccessible",
    );
  } finally {
    db.close();
  }
});
