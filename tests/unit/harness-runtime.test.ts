import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, link, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { HarnessConversations, type HarnessConversationOptions } from "../../src/server/harness/conversations.js";
import { HarnessStdioTransport } from "../../src/server/harness/adapters/stdio.js";
import type { HarnessAgent, HarnessAgentEvent, HarnessAgentInfo } from "../../src/server/harness/ports.js";
import { HarnessError, HarnessPromptError, type HarnessPermissionMode } from "../../src/shared/harness/contracts.js";
import { HarnessDiagnostics } from "../../src/server/harness/diagnostics.js";
import { applicationRuntimes } from "../../src/server/harness/application.js";
import {
  allowsHarnessOutputWrite,
  createHarnessWorkspace,
  harnessOutputReader,
} from "../../src/server/harness/workspaces.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import {
  memoryFixtureOrganizer,
  memoryFixturePolicy,
  runDueMemory,
  stageCompletedMemory,
} from "../support/memory-organization.js";
import type { ModelReviewPort } from "../../src/server/project-memory/model-review.js";
import { conversationKey, type MemoryConversation } from "../../src/server/project-memory/records.js";
import { decode, save } from "../../src/server/harness/records.js";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";
import type { ProjectSessionMembership } from "../../src/server/projects/session-membership.js";
import { harnessConversationId } from "../../src/shared/harness/presentation.js";
import { serveHostAgent } from "../../src/server/harness/host.js";
const directories: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "panda-harness-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const administrator = { owner: "one", administrator: true };

test("native output readers return only bounded originals within the captured runtime workspace", async () => {
  const root = await temporary();
  const directory = join(root, "workspace");
  await mkdir(directory);
  const read = await harnessOutputReader(directory);
  await writeFile(join(directory, "proof.html"), "<p>Native original</p>");
  await writeFile(join(root, "other.html"), "Private unrelated file");
  await symlink(join(root, "other.html"), join(directory, "symlink.html"));
  await link(join(root, "other.html"), join(directory, "hardlink.html"));
  expect((await read("proof.html")).toString()).toBe("<p>Native original</p>");
  expect(await allowsHarnessOutputWrite(directory, "native.png")).toBe(true);
  for (const name of ["../other.html", "symlink.html", "hardlink.html", join(root, "other.html")]) {
    await expect(read(name)).rejects.toThrow();
    expect(await allowsHarnessOutputWrite(directory, name)).toBe(false);
  }
  await rename(directory, join(root, "retired"));
  await mkdir(directory);
  await writeFile(join(directory, "proof.html"), "Substitute file");
  await expect(read("proof.html")).rejects.toMatchObject({ code: "workspaceUnavailable" });
});

test("host Harness sockets run and resume native sessions with the credentials owned on the host", async () => {
  const directory = await temporary();
  await writeFile(join(directory, "signed-in"), "");
  await writeFile(join(directory, "auth.json"), JSON.stringify({ fixture: { access_token: "fixture" } }));
  const provider = join(directory, "zcode-provider.json");
  await writeFile(provider, "{}");
  const command = (name: string) => join(import.meta.dir, `../support/${name}.mjs`);
  const baseEnv = { PATH: process.env.PATH, HOME: directory };
  const engines = [
    [
      "claude-code",
      "antigravity-acp-fixture",
      [],
      {
        ...baseEnv,
        CLAUDE_CODE_EXECUTABLE: command("antigravity-acp-fixture"),
        CLAUDE_AGENT_ACP_PROTOCOL: "v1",
        CLAUDE_CONFIG_DIR: join(directory, ".claude"),
      },
      "Claude reply",
    ],
    ["antigravity", "antigravity-acp-fixture", ["acp"], baseEnv, "Antigravity reply"],
    ["grok-build", "grok-acp-fixture", ["agent", "stdio"], { ...baseEnv, GROK_HOME: directory }, "Grok fixture reply"],
    [
      "zcode",
      "zcode-stdio-fixture",
      ["app-server", "--stdio"],
      { ...baseEnv, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: provider },
      "Fixture ZCode",
    ],
  ] as const;
  const profiles = await Promise.all(
    engines.map(async ([kind, name, args, env, reply]) => {
      const socketPath = join(directory, kind + ".sock");
      const service = await serveHostAgent({ socketPath, command: command(name), args: [...args], env });
      cleanups.push(service.close);
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      return {
        id: kind + "-host",
        name: kind,
        kind,
        socketPath,
        reply,
        ...(kind === "zcode" ? { providerId: "fixture", model: "zcode-fixture" } : {}),
      };
    }),
  );
  const { harnessProfiles } = await import("../../src/server/harness/profiles.js");
  const metadata = new SQLiteHarnessMetadata(join(directory, "host.sqlite"));
  cleanups.push(async () => metadata.close());
  const registry = new HarnessRegistry(
    metadata,
    harnessProfiles(directory, {} as Parameters<typeof harnessProfiles>[1], {
      PANDA_FORCE_HOST_HARNESS_PROFILES: JSON.stringify(profiles),
    }),
  );
  await registry.initialize();
  expect((await registry.catalog({ owner: "member", administrator: false })).runtimes).toEqual([]);
  let catalogDirectory = "";
  const port = applicationRuntimes({
    registry,
    scratchRoot: join(directory, "private-catalog"),
    async hostWorkspace() {
      const workspace = await createHarnessWorkspace(directory, "host-catalog-", true);
      catalogDirectory = workspace.cwd;
      return workspace;
    },
    principal: async (owner) => ({ owner, administrator: owner === administrator.owner }),
    codex: () => {
      throw Error("No Codex engine expected");
    },
  });
  const catalog = await port.discover(administrator.owner, "claude-code-host", true);
  expect(catalog.models.map(({ id }) => id)).toContain("claude-fixture");
  expect(catalogDirectory).toStartWith(join(directory, "host-catalog-"));
  await expect(stat(catalogDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(port.discover("member", "claude-code-host", true)).rejects.toMatchObject({ code: "notFound" });
  for (const { id, reply } of profiles) {
    expect(registry.supportsApplication(id)).toBe(false);
    expect(registry.usesHostSocket(id)).toBe(true);
    const view = (await registry.catalog(administrator)).profiles.find((profile) => profile.id === id);
    expect(view).toBeDefined();
    expect(view).not.toHaveProperty("hostSocket");
    const first = await registry.agent(administrator, id, "conversation", directory);
    let session: Awaited<ReturnType<typeof first.agent.create>>;
    try {
      session = await first.agent.create(directory);
      let output = "";
      await first.agent.prompt(
        session,
        { text: "Test host mode", attachments: [], model: null, effort: null, operationId: "host" },
        async (event) => {
          if (event.type === "text") output += event.text;
        },
      );
      expect(output).toContain(reply);
    } finally {
      await first.agent.close();
    }
    const second = await registry.agent(administrator, id, "conversation", directory);
    try {
      expect((await second.agent.load(session.id, directory)).id).toBe(session.id);
    } finally {
      await second.agent.close();
    }
  }
});

async function verifyScopedBotDecision(registry: HarnessRegistry, directory: string, runtimeId: string, model: string) {
  const application = applicationRuntimes({
    registry,
    scratchRoot: join(directory, "applications"),
    principal: async () => administrator,
    codex() {
      throw Error("Unexpected Codex execution");
    },
  });
  const calls: string[] = [];
  const outcome = await application
    .engine(administrator.owner, { runtimeId, model, effort: "high" }, directory, "bots")
    .run(
      {
        instructions: "Follow Bot instructions",
        prompt: "Make one scoped decision.",
        tools: [{ name: "panda_bot_decide", description: "Decide", inputSchema: { type: "object" } }],
      },
      {
        signal: new AbortController().signal,
        started() {},
        async call({ name }) {
          calls.push(name);
          return { success: true, text: "allowed" };
        },
      },
    );
  expect(outcome.status).toBe("completed");
  expect(calls).toEqual(["panda_bot_decide"]);
}

test("Claude Code uses its native account, reports sign-in and resumes a conversation with approvals", async () => {
  const directory = await temporary();
  const accountHome = join(directory, "claude-account");
  await mkdir(accountHome, { mode: 0o700 });
  const { harnessProfiles } = await import("../../src/server/harness/profiles.js");
  const command = join(import.meta.dir, "../support/antigravity-acp-fixture.mjs");
  const metadata = new SQLiteHarnessMetadata(join(directory, "claude.sqlite"));
  cleanups.push(async () => metadata.close());
  const registry = new HarnessRegistry(
    metadata,
    harnessProfiles(directory, {} as Parameters<typeof harnessProfiles>[1], {
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: "fixture-key-that-must-not-be-inherited",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-token-that-must-not-be-inherited",
      PANDA_FORCE_CLAUDE_CODE_HARNESS_PROFILES: JSON.stringify([
        { id: "claude-code", name: "Claude Code", command, claudeCommand: command, accountHome },
      ]),
    }),
  );
  await registry.initialize();
  expect(registry.supportsApplication("claude-code")).toBe(false);
  await expect(registry.require({ owner: "member", administrator: false }, "claude-code")).rejects.toMatchObject({
    code: "notFound",
  });
  await expect(registry.probe(administrator, "claude-code", directory)).rejects.toMatchObject({
    code: "authentication",
  });
  expect((await registry.catalog(administrator)).runtimes.find((value) => value.id === "claude-code")?.status).toBe(
    "authentication",
  );
  await writeFile(join(accountHome, "signed-in"), "");
  const catalog = await registry.probe(administrator, "claude-code", directory);
  expect(catalog.runtimes.find((value) => value.id === "claude-code")).toMatchObject({
    kind: "claude-code",
    status: "ready",
    capabilities: { permissionModes: ["ask", "accept-edits", "plan"] },
    models: [
      { id: "claude-fixture", isDefault: true, efforts: [{ id: "low" }, { id: "high" }] },
      { id: "claude-fixture-pro", isDefault: false, efforts: [{ id: "medium" }, { id: "high" }] },
    ],
  });
  await verifyScopedBotDecision(registry, directory, "claude-code", "claude-fixture");
  const denied = await registry.agent(administrator, "claude-code", "conversation", directory);
  cleanups.push(() => denied.agent.close());
  await expect(denied.agent.create(directory, { permissionMode: "full-access" })).rejects.toMatchObject({
    code: "capabilityUnavailable",
  });
  await denied.agent.close();

  for (const [file, permissionMode, nativeMode] of [
    ["native-edit", "accept-edits", "acceptEdits"],
    ["native-plan", "plan", "plan"],
    ["native-auto", "always-approve", "auto"],
    ["native-deny", "deny-unapproved", "dontAsk"],
    ["native-full", "full-access", "bypassPermissions"],
  ] as const) {
    await writeFile(join(accountHome, file), "");
    const discovered = (await registry.probe(administrator, "claude-code", directory)).runtimes.find(
      ({ id }) => id === "claude-code",
    )!;
    expect(discovered.capabilities?.permissionModes).toContain(permissionMode);
    const opened = await registry.agent(administrator, "claude-code", "conversation", directory);
    cleanups.push(() => opened.agent.close());
    const model = "claude-fixture-pro";
    const session = await opened.agent.create(directory, { permissionMode, model });
    expect(session.info?.models.find(({ id }) => id === model)?.efforts.map(({ id }) => id)).toEqual([
      "medium",
      "high",
    ]);
    await expect(
      opened.agent.prompt(
        session,
        { text: "claude.mode", attachments: [], model, effort: "medium", operationId: file },
        async (event) => expect(event).toEqual({ type: "text", text: nativeMode }),
      ),
    ).resolves.toMatchObject({ stopReason: "complete" });
    await opened.agent.close();
  }
  const first = await registry.agent(administrator, "claude-code", "conversation", directory);
  cleanups.push(() => first.agent.close());
  const session = await first.agent.create(directory);
  const input = {
    text: "claude.approval",
    attachments: [],
    model: "claude-fixture",
    effort: "low",
    operationId: "first",
  };
  const events: HarnessAgentEvent[] = [];
  await expect(
    first.agent.prompt(session, input, async (event) => {
      events.push(event);
      if (event.type === "permission") await first.agent.respondPermission(event.id, "yes");
    }),
  ).resolves.toMatchObject({ stopReason: "complete", usage: { totalTokens: 25 } });
  expect(events.at(-1)).toEqual({ type: "text", text: "Fixture approval received." });
  await first.agent.close();
  const next = await registry.agent(administrator, "claude-code", "conversation", directory);
  cleanups.push(() => next.agent.close());
  const resumed = await next.agent.load(session.id, directory);
  expect(resumed.id).toBe(session.id);
  await expect(
    next.agent.prompt(resumed, { ...input, text: "Follow-up" }, async (event) => {
      expect(event).toEqual({ type: "text", text: "Claude reply (low)." });
    }),
  ).resolves.toMatchObject({ stopReason: "complete" });
});

test("Antigravity profiles isolate account homes and resume approved ACP turns with measured usage", async () => {
  const directory = await temporary();
  const primary = join(directory, "primary");
  const secondary = join(directory, "secondary");
  await Promise.all([mkdir(primary), mkdir(secondary)]);
  const { harnessProfiles } = await import("../../src/server/harness/profiles.js");
  const metadata = new SQLiteHarnessMetadata(join(directory, "antigravity.sqlite"));
  cleanups.push(async () => metadata.close());
  const registry = new HarnessRegistry(
    metadata,
    harnessProfiles(directory, {} as Parameters<typeof harnessProfiles>[1], {
      PATH: process.env.PATH,
      PANDA_FORCE_ANTIGRAVITY_HARNESS_PROFILES: JSON.stringify(
        [
          { id: "google-primary", name: "Google Primary", accountHome: primary },
          { id: "google-secondary", name: "Google Secondary", accountHome: secondary },
        ].map((profile) => ({ ...profile, command: join(import.meta.dir, "../support/antigravity-acp-fixture.mjs") })),
      ),
    }),
  );
  await registry.initialize();
  expect(registry.supportsApplication("google-primary")).toBe(false);
  await expect(registry.require({ owner: "member", administrator: false }, "google-primary")).rejects.toMatchObject({
    code: "notFound",
  });
  await expect(registry.probe(administrator, "google-primary", directory)).rejects.toMatchObject({
    code: "authentication",
  });
  await writeFile(join(primary, "signed-in"), "");
  const ready = await registry.probe(administrator, "google-primary", directory);
  expect(ready.runtimes.find((runtime) => runtime.id === "google-primary")?.status).toBe("ready");
  await expect(registry.probe(administrator, "google-secondary", directory)).rejects.toMatchObject({
    code: "authentication",
  });

  await verifyScopedBotDecision(registry, directory, "google-primary", "gemini-fixture");
  const first = await registry.agent(administrator, "google-primary", "conversation", directory);
  cleanups.push(() => first.agent.close());
  const session = await first.agent.create(directory);
  const input = {
    text: "antigravity.approval",
    attachments: [],
    model: "gemini-fixture",
    effort: "low",
    operationId: "one",
  };
  const events: HarnessAgentEvent[] = [];
  const complete = await first.agent.prompt(session, input, async (event) => {
    events.push(event);
    if (event.type === "permission") await first.agent.respondPermission(event.id, "yes");
  });
  expect(events.map((event) => event.type)).toEqual(["activity", "tool", "permission", "tool", "text"]);
  expect(events.at(-1)).toEqual({ type: "text", text: "Fixture approval received." });
  expect(complete).toEqual({
    stopReason: "complete",
    usage: {
      inputTokens: 20,
      outputTokens: 5,
      reasoningOutputTokens: 1,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 0,
      totalTokens: 25,
    },
  });
  await first.agent.close();

  const resumed = await registry.agent(administrator, "google-primary", "conversation", directory);
  cleanups.push(() => resumed.agent.close());
  const same = await resumed.agent.load(session.id, directory);
  expect(same.id).toBe(session.id);
  expect(same.info?.models[0]?.efforts.map((effort) => effort.id)).toEqual(["low", "high"]);
  await expect(
    resumed.agent.prompt(same, { ...input, text: "follow-up" }, async (event) => {
      expect(event).toEqual({ type: "text", text: "Antigravity reply (low)." });
    }),
  ).resolves.toMatchObject({ stopReason: "complete" });
  await expect(
    resumed.agent.prompt(same, { ...input, text: "antigravity.hold" }, async (event) => {
      if (event.type === "activity") await resumed.agent.cancel(same);
    }),
  ).resolves.toEqual({ stopReason: "cancelled" });
  await resumed.agent.close();

  const auto = await registry.agent(administrator, "google-primary", "conversation", directory, {
    permissionMode: "always-approve",
  });
  cleanups.push(() => auto.agent.close());
  await expect(auto.agent.load(session.id, directory)).rejects.toMatchObject({ code: "capabilityUnavailable" });
  const autoSession = await auto.agent.load(session.id, directory, { permissionMode: "always-approve" });
  expect(autoSession.id).toBe(session.id);
  const autoEvents: HarnessAgentEvent[] = [];
  await expect(
    auto.agent.prompt(autoSession, input, async (event) => {
      autoEvents.push(event);
      if (event.type === "permission") await auto.agent.respondPermission(event.id, null);
    }),
  ).resolves.toMatchObject({ stopReason: "complete" });
  expect(autoEvents).toEqual([{ type: "text", text: "Fixture native auto-approval active." }]);
});

const info: HarnessAgentInfo = {
  capabilities: {
    text: true,
    imageInput: true,
    fileInput: true,
    models: true,
    load: true,
    tools: true,
    permissions: true,
    imageGeneration: "unknown",
  },
  currentModel: "model",
  commands: [],
  models: [{ id: "model", name: "Model", efforts: [{ id: "high", name: "High" }] }],
};
async function eventually(predicate: () => Promise<boolean>) {
  for (let count = 0; count < 200; count++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("conditionTimeout");
}
async function fixture(
  options: {
    fail?: boolean;
    hold?: boolean;
    memory?: boolean;
    projectBinding?: (id: string) => Promise<ProjectSessionMembership | null>;
    beforeOpen?: () => Promise<void>;
    modelReview?: ModelReviewPort;
    memoryClock?: () => number;
    sourcePage?: HarnessConversationOptions["sourcePage"];
    initialInfo?: HarnessAgentInfo;
    sessionInfo?: HarnessAgentInfo;
    openFailure?: HarnessError;
  } = {},
) {
  const directory = await temporary(),
    metadata = new SQLiteHarnessMetadata(join(directory, "metadata.sqlite"));
  const prompts: Array<{ runtime: string; session: string; cwd: string; text: string; model: string | null }> = [];
  const openedModes: Array<HarnessPermissionMode | undefined> = [];
  let opened = 0,
    closed = 0;
  const open = async (cwd: string, id = randomUUID()) => {
    opened++;
    if (options.openFailure) throw options.openFailure;
    await options.beforeOpen?.();
    return { id, cwd, ...(options.sessionInfo ? { info: options.sessionInfo } : {}) };
  };
  let release: (() => void) | null = null;
  const registry = new HarnessRegistry(
    metadata,
    ["codex", "grok-build"].map((id) => ({
      id,
      name: id,
      kind: id === "codex" ? ("codex" as const) : ("grok-build" as const),
      deployment: "local" as const,
      factory: {
        create: async (): Promise<HarnessAgent> => ({
          initialize: async () => options.initialInfo ?? info,
          create: async (cwd, config) => {
            openedModes.push(config?.permissionMode);
            return open(cwd);
          },
          load: async (id, cwd, config) => {
            openedModes.push(config?.permissionMode);
            return open(cwd, id);
          },
          prompt: async (session, input, emit) => {
            prompts.push({ runtime: id, session: session.id, cwd: session.cwd, text: input.text, model: input.model });
            if (options.hold) await new Promise<void>((resolve) => (release = resolve));
            if (options.fail) throw Error("disconnect");
            await emit({ type: "text", text: `${id} reply` });
            return { stopReason: "complete" };
          },
          cancel: async () => release?.(),
          respondPermission: async () => {},
          close: async () => {
            closed++;
            release?.();
          },
        }),
      },
    })),
  );
  await registry.initialize();
  const history = new JsonlHarnessHistory(join(directory, "history"));
  const memory = new ProjectMemory(
    metadata,
    history,
    async () => {},
    undefined,
    options.memoryClock,
    options.projectBinding,
    options.modelReview ?? memoryFixtureOrganizer,
  );
  const conversations = new HarnessConversations({
    metadata,
    history,
    memory: options.memory ? memory : undefined,
    registry,
    workspace: async () => directory,
    authorize: async () => {},
    attachments: async () => [],
    sourcePage: options.sourcePage,
  });
  cleanups.push(async () => {
    await conversations.close();
    await memory.close();
    await metadata.close();
  });
  return {
    directory,
    memory,
    metadata,
    registry,
    conversations,
    prompts,
    openedModes,
    settleMemory: () => runDueMemory(metadata, memory),
    lifecycle: () => ({ opened, closed }),
    release: () => release?.(),
  };
}
test("project memory learns a completed user's convention, scopes recall and refreshes revoked native bindings", async () => {
  const { conversations, memory, prompts, metadata, settleMemory } = await fixture({ memory: true });
  const projectId = "atlas";
  const create = async (projectId: string, runtimeId: string, principal = administrator) =>
    (await conversations.create(principal, { projectId, runtimeId })).conversation.id;
  const source = await create(projectId, "codex");
  const release = await create(projectId, "grok-build");
  const sibling = await create("another-project", "grok-build");
  const neighbor = { owner: "neighbor", administrator: true };
  const privateConversation = await create(projectId, "grok-build", neighbor);
  const send = async (id: string, text: string, principal = administrator) => {
    const response = await conversations.submit(principal, id, { requestId: randomUUID(), text });
    await eventually(async () => (await conversations.snapshot(principal, id)).run?.status === "complete");
    await settleMemory();
    return response.runId;
  };

  await send(source, "Project convention [release]: cache ttl = ignored");
  expect(await memory.catalog(administrator.owner, projectId)).toEqual([]);
  await memory.configure(administrator.owner, projectId, {
    revision: 0,
    write: true,
    recall: true,
    model: memoryFixturePolicy,
  });
  await memory.configure(neighbor.owner, projectId, {
    revision: 0,
    write: true,
    recall: true,
    model: memoryFixturePolicy,
  });
  await memory.configure(administrator.owner, "another-project", {
    revision: 0,
    write: true,
    recall: true,
    model: memoryFixturePolicy,
  });
  await send(source, "Project convention [release]: cache ttl = 24 hours");
  await eventually(async () => (await memory.catalog(administrator.owner, projectId)).length === 1);
  await send(sibling, "What is the release cache ttl?");
  expect(prompts.at(-1)!.text).not.toContain("24 hours");
  await send(privateConversation, "What is the release cache ttl?", neighbor);
  expect(prompts.at(-1)!.text).not.toContain("24 hours");
  await send(release, "What is the normal cache ttl?");
  expect(prompts.at(-1)!.text).not.toContain("24 hours");
  const memoryId = (await memory.catalog(administrator.owner, projectId))[0]!.id;
  const runId = await send(release, "What is the release cache ttl?");
  const previous = prompts.at(-1)!;
  expect(previous.text).toContain("24 hours");
  expect(previous.text).toContain(source);
  expect(previous.runtime).toBe("grok-build");
  expect((await conversations.memoryDetails(administrator, release)).recalls).toMatchObject([
    { runId, status: "sent" },
  ]);
  await send(release, "Remind me of the release cache ttl");
  expect(prompts.at(-1)!.session).toBe(previous.session);
  expect(prompts.at(-1)!.text).not.toContain("24 hours");

  await conversations.delete(administrator, source);
  await expect(memory.detail(administrator.owner, projectId, memoryId)).rejects.toMatchObject({ code: "notFound" });
  expect(await memory.catalog(administrator.owner, projectId)).toEqual([]);
  expect((await conversations.memoryDetails(administrator, release)).recalls).toMatchObject([{ references: [] }]);
  await send(release, "Remind me of the release cache ttl");
  expect(prompts.at(-1)!.session).not.toBe(previous.session);
  expect(prompts.at(-1)!.text).not.toContain("24 hours");
  expect(await metadata.list("project-memory-job")).toEqual([]);
}, 20000);

test("project archives preview changes, migrate across stores, recall with opt-in and withdraw package evidence", async () => {
  const origin = await fixture({ memory: true });
  const target = await fixture({ memory: true });
  const owner = administrator.owner;
  const authorize = async () => {};
  const learn = async (f: typeof origin, projectId: string, value: string) => {
    const id = (await f.conversations.create(administrator, { projectId })).conversation.id;
    await f.conversations.submit(administrator, id, {
      requestId: randomUUID(),
      text: `Project convention: release cycle = ${value}`,
    });
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    await f.settleMemory();
    await eventually(async () => (await f.memory.catalog(owner, projectId)).some((entry) => entry.value === value));
    return id;
  };
  await origin.memory.configure(owner, "origin", {
    revision: 0,
    write: true,
    recall: false,
    model: memoryFixturePolicy,
  });
  const source = await learn(origin, "origin", "7 days");
  const archive = await origin.memory.exportArchive(owner, "origin");
  expect(archive.records).toEqual([{ key: "release-cycle", scope: "project", values: ["7 days"] }]);
  expect(JSON.stringify(archive)).not.toContain(source);
  expect(JSON.stringify(archive)).not.toContain("Project convention");
  const preview = async (project: string) => {
    const result = await target.memory.archiveImport(owner, project, archive, undefined, authorize);
    if (!("token" in result)) throw Error("Missing archive preview");
    return result;
  };
  const commit = (project: string, token: string) =>
    target.memory.archiveImport(owner, project, archive, token, authorize);

  const initial = await preview("target");
  expect(initial.added).toBe(1);
  await expect(
    target.memory.archiveImport(owner, "target", archive, initial.token, async (_owner, _project, access) => {
      if (access === "contribute") throw new HarnessError("forbidden", 403);
    }),
  ).rejects.toMatchObject({ status: 403 });

  expect(await target.memory.catalog(owner, "target")).toEqual([]);
  await target.memory.configure(owner, "target", {
    revision: 0,
    write: true,
    recall: false,
    model: memoryFixturePolicy,
  });
  await learn(target, "target", "14 days");
  await expect(commit("target", initial.token)).rejects.toMatchObject({ status: 409 });
  const conflict = await preview("target");
  expect(conflict.conflict).toBe(1);
  const receipt = await commit("target", conflict.token);
  expect(await commit("target", conflict.token)).toEqual(receipt);
  expect(await target.memory.catalog(owner, "target")).toMatchObject([
    { key: "release-cycle", state: "conflict", packages: [archive.packageId] },
  ]);
  expect(await target.memory.archiveImports(owner, "target")).toHaveLength(1);
  await target.memory.withdrawArchive(owner, "target", archive.packageId);
  expect(await target.memory.catalog(owner, "target")).toMatchObject([{ state: "active", value: "14 days" }]);
  expect((await preview("target")).withdrawn).toBe(true);
  await expect(commit("target", conflict.token)).rejects.toMatchObject({ status: 409 });

  const copy = await preview("copy");
  await commit("copy", copy.token);
  const conversation = (await target.conversations.create(administrator, { projectId: "copy" })).conversation.id;
  const ask = async () => {
    await target.conversations.submit(administrator, conversation, {
      requestId: randomUUID(),
      text: "What is the release cycle?",
    });
    await eventually(
      async () => !(await target.conversations.snapshot(administrator, conversation)).conversation.activeRunId,
    );
    return target.prompts.at(-1)!;
  };
  expect((await ask()).text).not.toContain("7 days");
  await target.memory.configure(owner, "copy", { revision: 0, write: false, recall: true });
  const recalled = await ask();
  expect(recalled.text).toContain("7 days");
  expect(recalled.text).toContain(archive.packageId);
  expect((await target.conversations.memoryDetails(administrator, conversation)).recalls[0]).toMatchObject({
    status: "sent",
    references: [{ packages: [archive.packageId] }],
  });
  expect(await target.memory.catalog("another-owner", "copy")).toEqual([]);
  await target.memory.withdrawArchive(owner, "copy", archive.packageId);
  const withdrawn = await ask();
  expect(withdrawn.text).not.toContain("7 days");
  expect(withdrawn.session).not.toBe(recalled.session);

  await origin.conversations.delete(administrator, source);
  expect((await origin.memory.exportArchive(owner, "origin")).records).toEqual([]);
  await expect(origin.memory.archiveImport(owner, "stale", archive, undefined, authorize)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    target.memory.archiveImport(owner, "forgery", { ...archive, records: [] }, undefined, authorize),
  ).rejects.toMatchObject({ status: 400 });
}, 30_000);

test("only the catalog's project binding permits memory, and a first link does not process earlier turns", async () => {
  const binding = new Map<string, ProjectSessionMembership>();
  const { conversations, memory, prompts, settleMemory } = await fixture({
    memory: true,
    projectBinding: async (id) => binding.get(id) ?? null,
  });
  const projectId = "atlas";
  const owner = administrator.owner;
  const source = (await conversations.create(administrator, { projectId })).conversation.id;
  const target = (await conversations.create(administrator, { projectId })).conversation.id;
  binding.set(source, { projectId, checkpoint: null });
  await memory.configure(owner, projectId, { revision: 0, write: true, recall: true, model: memoryFixturePolicy });
  const send = async (id: string, text: string) => {
    await conversations.submit(administrator, id, { requestId: randomUUID(), text });
    await eventually(async () => (await conversations.snapshot(administrator, id)).run?.status === "complete");
    await settleMemory();
  };
  await send(source, "Project convention [release]: cache ttl = 24 hours");
  await eventually(async () => (await memory.catalog(owner, projectId)).length === 1);
  await send(target, "What is the release cache ttl?");
  expect(prompts.at(-1)!.text).toContain("What is the release cache ttl?");
  expect(prompts.at(-1)!.text).not.toContain("24 hours");
  await send(target, "Project convention [release]: pre-link token = excluded");
  await expect(conversations.memoryDetails(administrator, target)).rejects.toMatchObject({ code: "notFound" });

  binding.set(target, { projectId, checkpoint: null });
  expect((await conversations.memoryDetails(administrator, target)).contributions.entries).toEqual([]);
  await send(target, "What is the release cache ttl?");
  expect(prompts.at(-1)!.text).toContain("24 hours");
  await send(target, "Project convention [release]: cleanup interval = 3 days");
  await eventually(async () => (await memory.catalog(owner, projectId)).length === 2);
  expect((await memory.catalog(owner, projectId)).map(({ key }) => key).sort()).toEqual([
    "cache-ttl",
    "cleanup-interval",
  ]);
}, 20000);

test("the first durable project checkpoint excludes an in-flight independent turn and rejects a pre-link outbox record", async () => {
  const root = await temporary();
  const path = join(root, "projects.sqlite");
  const catalog = new ProjectCatalog(path);
  const project = catalog.save({ name: "Atlas", code: "atlas" }, 0).projects[0]!;
  const owner = administrator.owner;
  const start = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let pause = false;
  try {
    const { conversations, memory, metadata, prompts, settleMemory } = await fixture({
      memory: true,
      projectBinding: async (id) => catalog.sessionMembership(harnessConversationId(id)),
      beforeOpen: async () => {
        if (!pause) return;
        start.resolve();
        await resume.promise;
      },
    });
    const bind = (id: string) =>
      conversations.withAssignmentCheckpoints(administrator, [id], async ([session]) =>
        catalog.bindSession(project.id, session!),
      );
    const complete = async (id: string) => {
      await eventually(async () => (await conversations.snapshot(administrator, id)).run?.status === "complete");
      await settleMemory();
    };
    const send = (id: string, text: string) =>
      conversations.submit(administrator, id, { text, requestId: randomUUID() });
    const source = (await conversations.create(administrator, {})).conversation.id;
    const target = (await conversations.create(administrator, {})).conversation.id;
    await memory.configure(owner, project.id, { revision: 0, write: true, recall: true, model: memoryFixturePolicy });
    await bind(source);
    await send(source, "Project convention [release]: cache ttl = 24 hours");
    await complete(source);
    await eventually(async () => (await memory.catalog(owner, project.id)).length === 1);

    pause = true;
    const question = "What is the release cache ttl?";
    await send(target, question);
    await start.promise;
    const before = decode<MemoryConversation>(await metadata.read(conversationKey(target)))!;
    await bind(target);
    const first = {
      projectId: project.id,
      checkpoint: { throughSeq: before.lastSeq, throughBytes: before.historyBytes },
    };
    expect(catalog.sessionMembership(harnessConversationId(target))).toEqual(first);
    expect(
      catalog.snapshot().assignments.find((session) => session.id === harnessConversationId(target)),
    ).not.toHaveProperty("checkpoint");
    pause = false;
    resume.resolve();
    await complete(target);
    expect(prompts.at(-1)!.text).toContain(question);
    expect(prompts.at(-1)!.text).not.toContain("24 hours");
    expect((await conversations.memoryDetails(administrator, target)).recalls).toEqual([]);

    await send(target, question);
    await complete(target);
    expect(prompts.at(-1)!.text).toContain("24 hours");

    const old = (await conversations.create(administrator, {})).conversation.id;
    const statement = "Project convention [release]: private label = excluded";
    await send(old, statement);
    await complete(old);
    const committed = decode<MemoryConversation>(await metadata.read(conversationKey(old)))!;
    const oldMessage = (await conversations.snapshot(administrator, old)).messages.find(
      (message) => message.text === statement,
    )!;
    await bind(old);
    await metadata.transaction((tx) => stageCompletedMemory(tx, memory, committed, oldMessage));
    await settleMemory();
    expect((await memory.catalog(owner, project.id)).map(({ key }) => key)).toEqual(["cache-ttl"]);

    await send(target, "Project convention [release]: deployment lock = 3 minutes");
    await complete(target);
    await eventually(async () => (await memory.catalog(owner, project.id)).length === 2);
    await bind(target);
    const restarted = new ProjectCatalog(path);
    try {
      expect(restarted.sessionMembership(harnessConversationId(target))).toEqual(first);
    } finally {
      restarted.close();
    }
  } finally {
    resume.resolve();
    catalog.close();
  }
}, 20000);

test("project memory isolates conflicting values and respects inherited source controls", async () => {
  const { conversations, memory, prompts, settleMemory } = await fixture({ memory: true });
  const projectId = "atlas";
  const first = (await conversations.create(administrator, { projectId })).conversation.id;
  const second = (await conversations.create(administrator, { projectId })).conversation.id;
  const target = (await conversations.create(administrator, { projectId })).conversation.id;
  await memory.configure(administrator.owner, projectId, {
    revision: 0,
    write: true,
    recall: true,
    model: memoryFixturePolicy,
  });
  const send = async (id: string, text: string) => {
    await conversations.submit(administrator, id, { requestId: randomUUID(), text });
    await eventually(async () => (await conversations.snapshot(administrator, id)).run?.status === "complete");
    await settleMemory();
  };
  const entries = () => memory.catalog(administrator.owner, projectId);
  await send(first, "项目约定 [release]：cache ttl = 24h");
  await send(second, "Project convention [release]: cache ttl = 7d");
  await eventually(async () => (await entries())[0]?.state === "conflict");
  const id = (await entries())[0]!.id;
  const detail = () => memory.detail(administrator.owner, projectId, id);
  await expect(detail()).rejects.toMatchObject({ code: "notFound" });
  expect(await memory.find(administrator.owner, projectId, "")).toEqual([]);
  await expect(memory.detail("someone-else", projectId, id)).rejects.toMatchObject({ code: "notFound" });
  await expect(memory.detail(administrator.owner, "other-project", id)).rejects.toMatchObject({ code: "notFound" });
  await send(target, "release cache ttl?");
  expect(prompts.at(-1)!.text).not.toContain("Project memory");
  const earlier = await conversations.memoryRemovalImpact(administrator, second);
  expect(earlier).toMatchObject({ recovers: 1, stops: 0, retains: 0, pauses: 0 });
  await conversations.rename(administrator, second, "Source for the conflict");
  await expect(
    conversations.configureMemory(administrator, second, {
      revision: 0,
      revoke: true,
      write: false,
      recall: null,
      impactToken: earlier.token,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  const fresh = await conversations.memoryRemovalImpact(administrator, second);
  await conversations.configureMemory(administrator, second, {
    revision: 0,
    revoke: true,
    write: false,
    recall: null,
    impactToken: fresh.token,
  });
  expect((await entries())[0]).toMatchObject({ value: "24h", state: "active" });
  const recovered = await detail();
  expect(recovered.versions.map((event) => event.reason)).toEqual(["recovered", "recorded"]);
  expect(JSON.stringify(recovered)).not.toContain(second);
  expect(recovered.versions.map((event) => event.entry?.value)).not.toContain("7d");
  await conversations.configureMemory(administrator, target, {
    revision: 0,
    revoke: false,
    write: null,
    recall: false,
  });
  await send(target, "release cache ttl?");
  expect(prompts.at(-1)!.text).not.toContain("Project memory");
  await conversations.configureMemory(administrator, target, { revision: 1, revoke: false, write: null, recall: null });
  await send(target, "release cache ttl?");
  expect(prompts.at(-1)!.text).toContain("24h");
  const update = (await conversations.create(administrator, { projectId })).conversation.id;
  await send(update, "Replace project convention [release]: cache ttl = 48h");
  await eventually(async () => (await entries())[0]?.value === "48h");
  expect((await detail()).versions[0]).toMatchObject({ reason: "replaced", entry: { value: "48h" } });
  const removal = await conversations.memoryRemovalImpact(administrator, update);
  expect(removal.stops).toBe(1);
  await conversations.delete(administrator, update, removal.token);
  expect(await entries()).toEqual([]);
  const withdrawn = await detail();
  expect(withdrawn.current).toBeNull();
  expect(withdrawn.versions[0]).toMatchObject({ reason: "withdrawn", entry: null });
  expect(JSON.stringify(withdrawn)).not.toContain("48h");
  expect(JSON.stringify(withdrawn)).not.toContain(update);
  await send(target, "release cache ttl?");
  expect(prompts.at(-1)!.text).not.toContain("24h");
}, 20000);

test("project memory resumes failed jobs with an expiring claim and bounded retry", async () => {
  const f = await fixture();
  let now = Date.now();
  let available = false;
  let reads = 0;
  const history = new JsonlHarnessHistory(join(f.directory, "history"));
  const memory = new ProjectMemory(
    f.metadata,
    history,
    async () => {
      reads++;
      if (!available) throw Error("test transient failure");
    },
    () => true,
    () => now,
    undefined,
    memoryFixtureOrganizer,
  );
  const project = "retry-project";
  const opened = await f.conversations.create(administrator, { projectId: project });
  const id = opened.conversation.id;
  await memory.configure(administrator.owner, project, {
    revision: 0,
    write: true,
    recall: true,
    model: memoryFixturePolicy,
  });
  const messageId = randomUUID(),
    runtimeId = "codex",
    runId = randomUUID();
  const text = "Project convention: test command = bun test";
  await f.metadata.transaction(async (tx) => {
    const row = await tx.get(conversationKey(id));
    const stored = decode<MemoryConversation>(row)!;
    const throughBytes = await history.append(stored.owner, id, stored.historyBytes, [
      {
        type: "message",
        seq: 1,
        message: {
          id: messageId,
          seq: 1,
          runId,
          runtimeId,
          model: null,
          attachments: [],
          text,
          status: "complete",
          createdAt: now,
          role: "user",
        },
      },
    ]);
    const next = { ...stored, lastSeq: 2, historyBytes: throughBytes };
    await save(tx, conversationKey(id), "conversation", stored.owner, next);
    await stageCompletedMemory(tx, memory, next, { id: messageId, runId, seq: 1 });
  });
  now += 5 * 60_000;
  await memory.processPending();
  await memory.processPending();
  expect(reads).toBe(1);
  const delayed = (await f.metadata.list("project-memory-organization"))[0]!;
  expect(delayed.updatedAt).toBeGreaterThan(now);
  const due = () => f.metadata.list("project-memory-organization", undefined, { limit: 1, updatedThrough: now });
  expect(await due()).toEqual([]);
  for (let iteration = 0; iteration < 3; iteration++) {
    now += 90_000;
    await memory.processPending();
  }
  const source = decode<MemoryConversation>(await f.metadata.read(conversationKey(id)))!;
  expect(await memory.contributions(source)).toMatchObject({ entries: [], pending: 0, failed: 1 });
  available = true;
  expect(await memory.retryFailed(source)).toEqual({ retried: 1 });
  expect(await memory.retryFailed(source)).toEqual({ retried: 0 });
  const queued = (await due())[0]!;
  await f.metadata.transaction((tx) =>
    tx.put({ ...queued, updatedAt: now + 30_000, revision: queued.revision + 1 }, queued.revision),
  );
  // A restarted worker waits for the abandoned claim to expire.
  const restarted = new ProjectMemory(
    f.metadata,
    history,
    async () => {
      reads++;
    },
    () => true,
    () => now,
    undefined,
    memoryFixtureOrganizer,
  );
  await restarted.processPending();
  expect((await restarted.contributions(source)).pending).toBe(1);
  now += 31_000;
  await restarted.processPending();
  expect(await memory.contributions(source)).toMatchObject({ pending: 0, failed: 0, entries: [{ value: "bun test" }] });
}, 20000);

test("conversation deletion is owned, idempotent and durable, and fences every history or send entry", async () => {
  const f = await fixture();
  const created = await f.conversations.create(administrator, { runtimeId: "grok-build" }),
    id = created.conversation.id;
  await expect(f.conversations.delete({ owner: "other", administrator: true }, id)).rejects.toMatchObject({
    code: "notFound",
  });
  await writeFile(join(f.directory, "project-sentinel.txt"), "unchanged");
  await f.conversations.delete(administrator, id);
  await f.conversations.delete(administrator, id);
  expect(await readFile(join(f.directory, "project-sentinel.txt"), "utf8")).toBe("unchanged");
  expect((await f.conversations.list(administrator)).map((row) => row.id)).not.toContain(id);
  await expect(f.conversations.snapshot(administrator, id)).rejects.toMatchObject({ code: "notFound" });
  await expect(
    f.conversations.submit(administrator, id, { requestId: randomUUID(), text: "Do not resurrect" }),
  ).rejects.toMatchObject({ code: "notFound" });
  await expect(f.conversations.rename(administrator, id, "Resurrect")).rejects.toMatchObject({ code: "notFound" });
  const stored = await f.metadata.read("conversation:" + id);
  expect(JSON.parse(stored!.data).archivedAt).toBeGreaterThan(0);
  expect(f.prompts).toHaveLength(0);
});
test("deleting an active Harness conversation is rejected without cancelling its execution", async () => {
  const f = await fixture({ hold: true });
  const created = await f.conversations.create(administrator, { runtimeId: "grok-build" }),
    id = created.conversation.id;
  const run = await f.conversations.submit(administrator, id, { requestId: randomUUID(), text: "hello" });
  await eventually(async () => f.prompts.length === 1);
  await expect(f.conversations.delete(administrator, id)).rejects.toMatchObject({ code: "busy" });
  expect((await f.conversations.snapshot(administrator, id)).conversation.activeRunId).toBe(run.runId);
  f.release();
  await eventually(async () => (await f.conversations.snapshot(administrator, id)).run?.status === "complete");
  await f.conversations.delete(administrator, id);
  await expect(f.conversations.snapshot(administrator, id)).rejects.toMatchObject({ code: "notFound" });
});
test("an uncertain stopped conversation can be deleted without replaying the native prompt", async () => {
  const f = await fixture({ fail: true });
  const { conversation } = await f.conversations.create(administrator, { runtimeId: "grok-build" });
  await f.conversations.submit(administrator, conversation.id, {
    requestId: randomUUID(),
    text: "Do not retry automatically",
  });
  await eventually(
    async () => (await f.conversations.snapshot(administrator, conversation.id)).run?.status === "uncertain",
  );
  await f.conversations.delete(administrator, conversation.id);
  await expect(f.conversations.resolveUncertain(administrator, conversation.id)).rejects.toMatchObject({
    code: "notFound",
  });
  expect(f.prompts).toHaveLength(1);
});
describe("Harness runtime ownership, transactions and portable context", () => {
  test("permission changes are owned, revision fenced, frozen while active and reset across runtimes", async () => {
    const f = await fixture({
      hold: true,
      initialInfo: { ...info, capabilities: { ...info.capabilities, permissionModes: ["ask", "always-approve"] } },
    });
    await f.registry.probe(administrator, "grok-build", f.directory);
    const created = await f.conversations.create(administrator, { runtimeId: "grok-build" });
    const id = created.conversation.id;
    await expect(
      f.conversations.configurePermission(
        { owner: "other", administrator: true },
        id,
        "always-approve",
        created.conversation.revision,
      ),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(
      f.conversations.configurePermission(administrator, id, "full-access", created.conversation.revision),
    ).rejects.toMatchObject({ code: "capabilityUnavailable" });
    await expect(
      f.conversations.configurePermission(administrator, id, "unknown", created.conversation.revision),
    ).rejects.toMatchObject({ code: "invalidInput" });
    const configured = await f.conversations.configurePermission(
      administrator,
      id,
      "always-approve",
      created.conversation.revision,
    );
    await expect(
      f.conversations.configurePermission(administrator, id, "ask", created.conversation.revision),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.conversations.submit(administrator, id, { requestId: randomUUID(), text: "one turn" });
    await eventually(async () => f.prompts.length === 1);
    expect(f.openedModes.at(-1)).toBe("always-approve");
    const active = await f.conversations.snapshot(administrator, id);
    await expect(
      f.conversations.configurePermission(administrator, id, "ask", active.conversation.revision),
    ).rejects.toMatchObject({ code: "busy" });
    expect(configured.conversation.permissionMode).toBe("always-approve");
    f.release();
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    const finished = await f.conversations.snapshot(administrator, id);
    const switched = await f.conversations.switch(administrator, id, "codex", finished.conversation.revision);
    expect(switched.conversation.permissionMode).toBe("ask");
    const unsupported = await fixture();
    await unsupported.registry.probe(administrator, "grok-build", unsupported.directory);
    await expect(
      unsupported.conversations.create(administrator, { runtimeId: "grok-build", permissionMode: "always-approve" }),
    ).rejects.toMatchObject({ code: "capabilityUnavailable" });
  });
  test("authenticated session models supersede the startup cache before dispatch validation", async () => {
    const sessionInfo = {
      ...info,
      currentModel: "new-model",
      models: [{ id: "new-model", name: "New model", efforts: [{ id: "high", name: "High" }] }],
    };
    const f = await fixture({ sessionInfo }),
      created = await f.conversations.create(administrator, { runtimeId: "grok-build" }),
      id = created.conversation.id;
    await f.conversations.submit(administrator, id, {
      requestId: randomUUID(),
      text: "Hello",
      model: "new-model",
      effort: "high",
    });
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    expect((await f.conversations.snapshot(administrator, id)).run?.status).toBe("complete");
    expect(f.prompts[0]!.model).toBe("new-model");
    await f.conversations.submit(administrator, id, {
      requestId: randomUUID(),
      text: "Invalid model",
      model: "model",
      effort: "high",
    });
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    expect((await f.conversations.snapshot(administrator, id)).run).toMatchObject({
      status: "error",
      error: "invalidInput",
    });
    expect(f.prompts).toHaveLength(1);
  });
  test("a connection probe opens an authenticated session and closes it even when authentication fails", async () => {
    const f = await fixture({ openFailure: new HarnessError("authentication", 503) });
    await expect(f.registry.probe(administrator, "grok-build", f.directory)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(f.lifecycle()).toEqual({ opened: 1, closed: 1 });
    expect((await f.registry.catalog(administrator)).runtimes.find((r) => r.id === "grok-build")?.status).toBe(
      "authentication",
    );
    expect(f.prompts).toHaveLength(0);
  });
  test("a successful probe publishes the authenticated session catalog without sending a prompt", async () => {
    const f = await fixture({ sessionInfo: { ...info, models: [{ id: "new-model", name: "New", efforts: [] }] } });
    const catalog = await f.registry.probe(administrator, "grok-build", f.directory);
    expect(catalog.runtimes.find((r) => r.id === "grok-build")).toMatchObject({
      status: "ready",
      models: [{ id: "new-model" }],
    });
    expect(f.prompts).toHaveLength(0);
    expect(f.lifecycle()).toEqual({ opened: 1, closed: 1 });
  });
  test("new Grok sessions observe atomically renewed account sources without changing the operator account", async () => {
    const { harnessProfiles } = await import("../../src/server/harness/profiles.js");
    type Driver = import("../../src/shared/engine/contracts.js").EngineDriver;
    const directory = await temporary(),
      account = join(directory, "account"),
      path = join(account, "auth.json");
    await mkdir(account);
    const expired = JSON.stringify({
      fixture: { access_token: "expired-fixture", refresh_token: "operator-only", rejectSession: true },
    });
    await writeFile(path, expired);
    const metadata = new SQLiteHarnessMetadata(join(directory, "profiles.sqlite"));
    cleanups.push(() => metadata.close());
    const registry = new HarnessRegistry(
      metadata,
      harnessProfiles(directory, {} as Driver, {
        PANDA_FORCE_HARNESS_PROFILES: JSON.stringify([
          {
            id: "grok-renewed",
            name: "Grok renewed",
            command: join(import.meta.dir, "../support/grok-acp-fixture.mjs"),
            accountHome: account,
          },
        ]),
        PATH: process.env.PATH,
      }),
    );
    await registry.initialize();
    await expect(registry.probe(administrator, "grok-renewed", directory)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(await readFile(path, "utf8")).toBe(expired);
    const renewed = JSON.stringify({
      fixture: { access_token: "renewed-fixture", refresh_token: "new-operator-only", rejectSession: false },
    });
    await writeFile(path + ".next", renewed);
    await rename(path + ".next", path);
    const catalog = await registry.probe(administrator, "grok-renewed", directory);
    expect(catalog.runtimes.find((r) => r.id === "grok-renewed")).toMatchObject({
      status: "ready",
      models: [{ id: "grok-fixture" }],
    });
    expect(await readFile(path, "utf8")).toBe(renewed);
  });
  test("explicit diagnostic messages coalesce repeats and keep workspaces and replies outside chat history", async () => {
    const f = await fixture();
    let cleaned = 0;
    const diagnostics = new HarnessDiagnostics(f.registry, async (runtime) => {
      expect(runtime.profileId).toBe("grok-build");
      expect(f.registry.usesHostSocket(runtime.profileId)).toBe(false);
      return {
        cwd: join(f.directory, "isolated-ping"),
        cleanup: async () => {
          cleaned++;
        },
      };
    });
    cleanups.push(() => diagnostics.close());
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      diagnostics.ping(administrator, "grok-build", requestId),
      diagnostics.ping(administrator, "grok-build", requestId),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "complete", reply: "grok-build reply" });
    expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]!.text).toStartWith("hi\n");
    expect(f.prompts[0]!.cwd).toEndWith("isolated-ping");
    expect(cleaned).toBe(1);
    expect(await f.metadata.list("conversation")).toHaveLength(0);
    await expect(
      diagnostics.ping({ ...administrator, administrator: false }, "grok-build", randomUUID()),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(diagnostics.ping(administrator, "codex", requestId)).rejects.toMatchObject({ code: "conflict" });
  });
  test("a timed-out diagnostic retains its receipt without resending and closes the native request", async () => {
    const f = await fixture({ hold: true }),
      diagnostics = new HarnessDiagnostics(f.registry, async () => ({ cwd: f.directory, cleanup: async () => {} }), 30);
    cleanups.push(() => diagnostics.close());
    const requestId = randomUUID();
    const first = diagnostics.ping(administrator, "grok-build", requestId);
    await expect(diagnostics.ping(administrator, "grok-build", randomUUID())).rejects.toMatchObject({ code: "busy" });
    expect(await first).toMatchObject({ status: "uncertain", error: "timeout" });
    expect(await diagnostics.ping(administrator, "grok-build", requestId)).toMatchObject({
      status: "uncertain",
      error: "timeout",
    });
    expect(f.prompts).toHaveLength(1);
    expect(f.lifecycle().closed).toBe(1);
  });
  test("separate runtime bindings preserve one visible transcript and transfer only missing visible messages", async () => {
    const f = await fixture(),
      created = await f.conversations.create(administrator, {}),
      id = created.conversation.id;
    const send = async (text: string) => {
      const requestId = randomUUID();
      await f.conversations.submit(administrator, id, { requestId, text });
      await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    };
    await send("first user message");
    let snapshot = await f.conversations.snapshot(administrator, id);
    await f.conversations.switch(administrator, id, "grok-build", snapshot.conversation.revision);
    await send("second user message");
    snapshot = await f.conversations.snapshot(administrator, id);
    await f.conversations.switch(administrator, id, "codex", snapshot.conversation.revision);
    await send("third user message");
    snapshot = await f.conversations.snapshot(administrator, id);
    expect(snapshot.messages.filter((message) => message.role !== "tool")).toHaveLength(6);
    expect(f.prompts.map((prompt) => prompt.cwd)).toEqual([f.directory, f.directory, f.directory]);
    expect(f.prompts[1]!.text).toContain("first user message");
    expect(f.prompts[1]!.text).toContain("codex reply");
    expect(f.prompts[2]!.text).toContain("second user message");
    expect(f.prompts[2]!.text).not.toContain("first user message");
    expect(f.prompts[0]!.session).toBe(f.prompts[2]!.session);
    expect(f.prompts[0]!.session).not.toBe(f.prompts[1]!.session);
    const owners = await readdir(join(f.directory, "history"));
    expect(await readdir(join(f.directory, "history", owners[0]!))).toEqual([id]);
    await expect(f.conversations.snapshot({ owner: "two", administrator: true }, id)).rejects.toMatchObject({
      code: "notFound",
    });
  });
  test("non-resumable engines use fresh sessions and retain visible context on consecutive sends", async () => {
    const f = await fixture({ initialInfo: { ...info, capabilities: { ...info.capabilities, load: false } } });
    const { conversation } = await f.conversations.create(administrator, { projectId: "atlas" });
    const inputs = ["Save the first detail", "Add a second detail", "Add a third detail"];
    for (const text of inputs) {
      await f.conversations.submit(administrator, conversation.id, { requestId: randomUUID(), text });
      await eventually(
        async () => !(await f.conversations.snapshot(administrator, conversation.id)).conversation.activeRunId,
      );
      expect((await f.conversations.snapshot(administrator, conversation.id)).run?.status).toBe("complete");
    }
    expect(new Set(f.prompts.map((prompt) => prompt.session)).size).toBe(inputs.length);
    expect(f.prompts[2]!.text).toContain(inputs[0]!);
    expect(f.prompts[2]!.text).toContain(inputs[1]!);
    expect(f.prompts[2]!.text).toContain("codex reply");
    const snapshot = await f.conversations.snapshot(administrator, conversation.id);
    expect(snapshot.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(
      inputs,
    );
  });
  test("repeated submission is coalesced; active execution cannot switch; defaults affect new conversations only", async () => {
    const f = await fixture({ hold: true }),
      created = await f.conversations.create(administrator, {}),
      id = created.conversation.id,
      requestId = randomUUID();
    const first = await f.conversations.submit(administrator, id, { requestId, text: "one" });
    const second = await f.conversations.submit(administrator, id, { requestId, text: "one" });
    expect(second).toEqual({ runId: first.runId, replay: true });
    await expect(f.conversations.submit(administrator, id, { requestId, text: "changed" })).rejects.toMatchObject({
      code: "conflict",
    });
    const snapshot = await f.conversations.snapshot(administrator, id);
    await expect(
      f.conversations.switch(administrator, id, "grok-build", snapshot.conversation.revision),
    ).rejects.toMatchObject({ code: "busy" });
    const runtime = (await f.registry.catalog(administrator)).runtimes.find((value) => value.id === "grok-build")!;
    await f.registry.configure(administrator, { ...runtime, makeDefault: true });
    expect((await f.conversations.create(administrator, {})).conversation.runtimeId).toBe("grok-build");
    expect((await f.conversations.snapshot(administrator, id)).conversation.runtimeId).toBe("codex");
    await eventually(async () => f.prompts.length === 1);
    f.release();
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    expect(f.prompts).toHaveLength(1);
  });
  test("dispatch failure stays uncertain without silent resend; explicit recovery discards the unsafe native binding", async () => {
    const f = await fixture({ fail: true }),
      snapshot = await f.conversations.create(administrator, {}),
      id = snapshot.conversation.id,
      requestId = randomUUID();
    await f.conversations.submit(administrator, id, { requestId, text: "one" });
    await eventually(async () => (await f.conversations.snapshot(administrator, id)).run?.status === "uncertain");
    expect((await f.conversations.submit(administrator, id, { requestId, text: "one" })).replay).toBe(true);
    expect(f.prompts).toHaveLength(1);
    await eventually(async () => {
      try {
        await f.conversations.resolveUncertain(administrator, id);
        return true;
      } catch {
        return false;
      }
    });
    expect((await f.conversations.snapshot(administrator, id)).conversation.activeRunId).toBeNull();
  });
  test("metadata rolls back across await and hides uncommitted state", async () => {
    const directory = await temporary(),
      store = new SQLiteHarnessMetadata(join(directory, "metadata.sqlite"));
    cleanups.push(() => store.close());
    await expect(
      store.transaction(async (tx) => {
        await tx.put({ id: "x", kind: "test", owner: "one", data: "{}", revision: 1, updatedAt: 1 }, null);
        await Promise.resolve();
        throw Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.read("x")).toBeNull();
    await store.transaction(async (tx) => {
      await tx.put({ id: "x", kind: "test", owner: "one", data: "{}", revision: 1, updatedAt: 1 }, null);
    });
    await expect(
      store.transaction((tx) =>
        tx.put({ id: "x", kind: "test", owner: "one", data: "{}", revision: 1, updatedAt: 1 }, null),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  test("JSONL ignores an interrupted tail and preserves the original committed frames", async () => {
    const directory = await temporary(),
      history = new JsonlHarnessHistory(directory),
      id = randomUUID();
    const first = { type: "status" as const, seq: 1, messageId: "x", status: "complete" as const };
    const offset = await history.append("owner", id, 0, [first]);
    await history.append("owner", id, offset, [{ ...first, seq: 2 }]);
    expect(await history.read("owner", id, offset)).toEqual([first]);
    const end = await history.append("owner", id, offset, [{ ...first, seq: 2, status: "error" }]);
    expect((await history.read("owner", id, end))[1]).toMatchObject({ status: "error" });
    const owner = (await readdir(directory))[0]!,
      path = join(directory, owner, id, "history.jsonl"),
      bytes = await readFile(path, "utf8");
    await writeFile(path, bytes.replace('"status":"complete"', '"status":"running" '));
    await expect(history.read("owner", id, end)).rejects.toMatchObject({ code: "historyCorrupt" });
  });
});
describe("Harness stdio protocol", () => {
  test("preserves fragmented UTF-8, waits for persisted notifications, handles bidirectional IDs and a definitive response before exit", async () => {
    const directory = await temporary(),
      script = join(directory, "agent.mjs");
    await writeFile(
      script,
      `import readline from 'node:readline'; const lines=readline.createInterface({input:process.stdin}); lines.on('line',line=>{const f=JSON.parse(line);if(f.method==='test'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,method:'permission',params:{}})+'\\n');}else if(f.result==='deny'){const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'text',params:{text:'你好'}})+'\\n');for(const byte of data)process.stdout.write(Buffer.from([byte]));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result:{ok:true}})+'\\n',()=>process.exit(0));}});`,
    );
    let persisted = false;
    const transport = new HarnessStdioTransport({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: process.env,
      onRequest: async () => "deny",
      onNotification: async (_method, params) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(params.text).toBe("你好");
        persisted = true;
      },
    });
    cleanups.push(() => transport.close());
    expect(await transport.request("test")).toEqual({ ok: true });
    expect(persisted).toBe(true);
  });
});

describe("bounded Harness handoff", () => {
  test("limits context independently of retained history and does not read attachment bodies", async () => {
    const { handoffContext } = await import("../../src/server/harness/context.js");
    const events = Array.from({ length: 1000 }, (_, index) => ({
      type: "message" as const,
      seq: index + 1,
      message: {
        id: String(index),
        seq: index + 1,
        runId: "run",
        role: index % 2 ? ("assistant" as const) : ("user" as const),
        runtimeId: "codex",
        model: "model",
        text: `message-${index}:` + "文".repeat(2000),
        attachments: [],
        status: "complete" as const,
        createdAt: 1,
      },
    }));
    const handoff = handoffContext(events, {
      afterSeq: 0,
      exclude: [],
      earlierHistoryOmitted: false,
      maxBytes: 16000,
      maxMessages: 8,
    });
    expect(handoff.messages.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(handoff))).toBeLessThan(17000);
    expect(handoff.messages.at(-1)?.content).toContain("message-999");
    expect(handoff.earlierHistoryOmitted).toBe(true);
    expect(handoff.clipped).toBe(true);
  });
  test("reads only a bounded tail of a multi-gigabyte transcript", async () => {
    const { open } = await import("node:fs/promises");
    const directory = await temporary(),
      history = new JsonlHarnessHistory(directory),
      id = randomUUID();
    const event = { type: "status" as const, seq: 5000000, messageId: "x", status: "complete" as const };
    const initial = await history.append("owner", id, 0, [event]);
    const owner = (await readdir(directory))[0]!,
      path = join(directory, owner, id, "history.jsonl"),
      frame = await readFile(path),
      start = 3 * 1024 ** 3;
    const file = await open(path, "r+");
    try {
      await file.truncate(start + frame.length + 1);
      await file.write(Buffer.concat([Buffer.from("\n"), frame]), 0, frame.length + 1, start);
    } finally {
      await file.close();
    }
    const window = await history.window("owner", id, start + initial + 1);
    expect(window.events).toEqual([event]);
    expect(window.truncated).toBe(true);
    expect(window.startBytes).toBe(start + 1);
  });
});

test("project memory scans bounded history pages through a large frame and stops at the committed offset", async () => {
  const history = new JsonlHarnessHistory(await temporary());
  const owner = "scan-fixture",
    id = randomUUID(),
    createdAt = Date.now();
  const event = (seq: number, text = "small", role: "user" | "assistant" = "user") => ({
    type: "message" as const,
    seq,
    message: {
      id: randomUUID(),
      seq,
      runId: randomUUID(),
      role,
      text,
      runtimeId: "codex",
      model: null,
      attachments: [],
      status: "complete" as const,
      createdAt,
    },
  });
  const first = Array.from({ length: 8 }, (_, index) => event(index + 1));
  const firstEnd = await history.append(owner, id, 0, first);
  const long = event(9, "x".repeat(900 * 1024), "assistant");
  const last = event(10, "last visible message");
  const committed = await history.append(owner, id, firstEnd, [long, last]);
  await history.append(owner, id, committed, [event(11, "uncommitted")]);

  const firstPage = await history.scanUserMessages(owner, id, committed, 0);
  expect(firstPage.nextBytes).toBe(firstEnd);
  expect(firstPage.messages.map(({ message }) => message.id)).toEqual(first.map(({ message }) => message.id));
  const finalPage = await history.scanUserMessages(owner, id, committed, firstPage.nextBytes);
  expect(finalPage).toEqual({ messages: [{ message: last.message, throughBytes: committed }], nextBytes: committed });
  await expect(history.scanUserMessages(owner, id, committed, firstEnd + 1)).rejects.toMatchObject({
    code: "historyCorrupt",
  });
  await expect(history.scanUserMessages(owner, id, committed - 1, firstEnd)).rejects.toMatchObject({
    code: "historyCorrupt",
  });
});

describe("timestamp history retrieval", () => {
  test("locates a source before a long transcript tail using committed offsets and legacy timestamps", async () => {
    const directory = await temporary();
    let clock = Date.parse("2026-11-20T12:00:00Z");
    const history = new JsonlHarnessHistory(directory, () => clock);
    const id = randomUUID();
    const original = {
      id: randomUUID(),
      seq: 1,
      runId: "run",
      role: "user" as const,
      runtimeId: "codex",
      model: null,
      text: "Project convention: retention = 30 days",
      attachments: [],
      status: "complete" as const,
      createdAt: clock,
    };
    const throughBytes = await history.append("one", id, 0, [{ type: "message", seq: 1, message: original }]);
    clock += 5000;
    const tail = "x".repeat(900_000);
    const later = { ...original, seq: 2, id: randomUUID(), text: tail, createdAt: clock };
    const committed = await history.append("one", id, throughBytes, [
      { type: "message", seq: 2, message: later },
      { type: "text", seq: 3, messageId: later.id, text: tail },
    ]);
    expect(committed - throughBytes).toBeGreaterThan(1024 * 1024);
    expect(
      (await history.window("one", id, committed, { maxBytes: 1024 * 1024 + 1 })).events.map(({ seq }) => seq),
    ).not.toContain(1);
    const pointer = { messageId: original.id, recordedAt: original.createdAt };
    expect(await history.messageAt("one", id, committed, { ...pointer, throughBytes })).toEqual(original);
    expect(await history.messageAt("one", id, committed, pointer)).toEqual(original);
    const uncommitted = { ...original, seq: 4, id: randomUUID() };
    await history.append("one", id, committed, [{ type: "message", seq: 4, message: uncommitted }]);
    expect(await history.messageAt("one", id, committed, { ...pointer, messageId: uncommitted.id })).toBeNull();
  });

  test("uses UTC timestamps, returns bounded pages, handles clock reversal and ignores uncommitted index entries", async () => {
    const directory = await temporary();
    let clock = Date.parse("2026-11-20T12:00:00Z");
    const history = new JsonlHarnessHistory(directory, () => clock),
      id = randomUUID();
    const event = (seq: number, value: string) => ({
      type: "text" as const,
      seq,
      messageId: "x",
      text: value,
      runtimeId: "grok-build",
      runId: "run",
    });
    const first = await history.append("one", id, 0, [event(1, "decision one")]);
    clock -= 1000;
    const committed = await history.append("one", id, first, [event(2, "decision two"), event(3, "other")]);
    const page = await history.queryTime("one", id, committed, {
      from: clock,
      to: clock + 1000,
      query: "decision",
      limit: 1,
    });
    expect(page.records[0]).toMatchObject({ seq: 1, timestamp: "2026-11-20T12:00:00.000Z", runtimeId: "grok-build" });
    const next = await history.queryTime("one", id, committed, {
      from: clock,
      to: clock + 1000,
      query: "decision",
      limit: 1,
      cursor: page.cursor!,
    });
    expect(next.records[0]!.seq).toBe(2);
    await history.append("one", id, committed, [event(4, "uncommitted")]);
    const snapshot = await history.queryTime("one", id, committed, { from: clock, to: clock + 1000 });
    expect(snapshot.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    const final = await history.append("one", id, committed, [event(4, "replacement")]);
    expect(
      (await history.queryTime("one", id, final, { from: clock, to: clock + 1000, query: "replacement" })).records,
    ).toHaveLength(1);
    const reference = await history.reference("one", id, final);
    const { runHarnessHistoryQuery } = await import("../../src/server/harness/history-cli.js");
    const cli = await runHarnessHistoryQuery([
      "--file",
      reference.path,
      "--committed-bytes",
      String(final),
      "--from",
      new Date(clock).toISOString(),
      "--to",
      new Date(clock + 1000).toISOString(),
      "--query",
      "replacement",
    ]);
    expect(cli.records[0]!.text).toBe("replacement");
  });
});

describe("Harness browser contracts", () => {
  test("keeps generated guidance out of titles and portable history while reconciling the client message alias", async () => {
    const f = await fixture(),
      created = await f.conversations.create(administrator, {}),
      id = created.conversation.id;
    const input =
      'Visible user message.\n<panda_session_skills>\n{"guidance":"internal guidance"}\n</panda_session_skills>';
    await f.conversations.submit(administrator, id, { requestId: randomUUID(), clientId: "local-100-1", text: input });
    await eventually(async () => !(await f.conversations.snapshot(administrator, id)).conversation.activeRunId);
    const snapshot = await f.conversations.snapshot(administrator, id);
    expect(snapshot.conversation.title).toBe("Visible user message.");
    expect(snapshot.messages[0]!.clientId).toBe("local-100-1");
    const { harnessPresentation } = await import("../../src/shared/harness/presentation.js");
    expect(harnessPresentation(snapshot).turns[0]!.items[0]!.clientId).toBe("local-100-1");
    const { handoffContext } = await import("../../src/server/harness/context.js");
    const pack = handoffContext([{ type: "message", seq: 1, message: { ...snapshot.messages[0]!, text: input } }], {
      afterSeq: 0,
      exclude: [],
      earlierHistoryOmitted: false,
    });
    expect(pack.messages[0]!.content).toBe("Visible user message.");
  });
  test("a late model catalog cannot overwrite the newly selected runtime", async () => {
    const { createModelCatalogLoader } = await import("../../src/client/session-controls/model-loader.js");
    let scope = "codex",
      resolveFirst: ((value: unknown) => void) | undefined;
    const accepted: unknown[] = [],
      failures: unknown[] = [];
    const load = createModelCatalogLoader({
      context: () => scope,
      request: async () =>
        scope === "codex"
          ? await new Promise((resolve) => (resolveFirst = resolve))
          : { type: "rpc/result", result: { data: [{ model: "grok" }] } },
      setStatus: () => {},
      changed: () => {},
      accept: (value) => accepted.push(value),
      failed: (error) => failures.push(error),
    });
    const old = load({ attempts: 1 });
    scope = "grok";
    await load({ attempts: 1 });
    resolveFirst!({ type: "rpc/result", result: { data: [{ model: "codex" }] } });
    await old;
    expect(accepted).toEqual([[{ model: "grok" }]]);
    expect(failures).toEqual([]);
  });
});

describe("Harness source history and materials", () => {
  test("loads older visible source pages without exporting native bindings or reading the whole source", async () => {
    const calls: string[] = [];
    const f = await fixture({
      sourcePage: async (_principal, id, cursor) => {
        calls.push(`${id}:${cursor}`);
        return {
          cwd: "",
          title: "",
          cursor: null,
          history: [{ id: "old-user", runId: "old-turn", role: "user", text: "An earlier decision", createdAt: 1000 }],
        };
      },
    });
    const created = await f.conversations.create(administrator, {
      source: { threadId: "original", cursor: "opaque" },
      history: [{ id: "recent-user", runId: "recent-turn", role: "user", text: "Continue", createdAt: 2000 }],
    });
    expect(created.history.nextCursor).toStartWith("source:");
    const older = await f.conversations.snapshot(administrator, created.conversation.id, {
      beforeBytes: 0,
      sourceCursor: "opaque",
      beforeSeq: 1,
    });
    expect(older.messages[0]).toMatchObject({ id: "old-user", seq: 0, createdAt: 1000 });
    expect(calls).toEqual(["original:opaque"]);
    const { harnessPresentation } = await import("../../src/shared/harness/presentation.js");
    const { mergeConversationHistory } = await import("../../src/client/ui-core.js");
    const current = harnessPresentation(created),
      page = harnessPresentation(older);
    const merged = mergeConversationHistory(
      current,
      { thread: page, history: { mode: "delta", turns: page.turns, nextCursor: null } },
      { page: true },
    );
    expect(merged.turns.map((turn) => turn.id)).toEqual(["old-turn", "recent-turn"]);
    const list = await f.conversations.list(administrator);
    expect(JSON.stringify(list)).not.toMatch(/"(source|owner|historyBytes|bindings|permissions|lastRunId)"/);
    expect(JSON.stringify(created.conversation)).not.toContain("original");
    await expect(
      f.conversations.snapshot({ owner: "other", administrator: true }, created.conversation.id),
    ).rejects.toMatchObject({ code: "notFound" });
  });
  test("stages only explicitly selected owned bytes, preserves the original filename, rejects links and conflicting staged files", async () => {
    const { HarnessMaterials } = await import("../../src/server/harness/materials.js");
    const root = await temporary(),
      id = randomUUID(),
      bytes = Buffer.from("Selected document");
    const material = { id, name: "项目说明.txt", kind: "file" as const, digest: "fixture" };
    const resolver = new HarnessMaterials({
      roots: [root],
      allows: (value) => value.startsWith(root + "/"),
      materials: () => ({
        prepare: async (owner, refs) => {
          if (owner !== "one" || JSON.stringify(refs) !== JSON.stringify([{ materialId: id }])) throw Error("notFound");
          return [material];
        },
        read: async () => ({ success: true, text: "" }),
        readOriginal: async () => bytes,
      }),
    });
    const f = await fixture(),
      created = await f.conversations.create(administrator, {});
    const conversation = { ...created.conversation, owner: "one", historyBytes: 0, cwd: root };
    const [selected] = await resolver.resolve(administrator, [`material:${id}`], conversation);
    expect(selected!.name).toBe(material.name);
    expect(await readFile(selected!.path)).toEqual(bytes);
    expect(selected!.url).toBe(`/api/chat-materials/original?id=${id}`);
    expect((await resolver.resolve(administrator, [`material:${id}`], conversation))[0]!.path).toBe(selected!.path);
    await expect(
      resolver.resolve({ owner: "two", administrator: true }, [`material:${id}`], conversation),
    ).rejects.toThrow();
    await writeFile(selected!.path, "Conflict");
    await expect(resolver.resolve(administrator, [`material:${id}`], conversation)).rejects.toMatchObject({
      code: "conflict",
    });
    const outside = join(root, "outside.txt"),
      link = join(root, "attachments", "input", "link.txt");
    await writeFile(outside, "Private unrelated file");
    await mkdir(join(root, "attachments", "input"), { recursive: true });
    await symlink(outside, link);
    await expect(resolver.resolve(administrator, [link], conversation)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      resolver.resolve(administrator, ["https://unrelated.example/file"], conversation),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

test("ZCode runs scoped Bot and creation tools with independent access", async () => {
  const { harnessProfiles } = await import("../../src/server/harness/profiles.js");
  const root = await temporary();
  const providerConfig = join(root, "provider.json");
  await writeFile(
    providerConfig,
    JSON.stringify({ applicationProbe: true, expectedInstruction: "Follow operator instructions." }),
  );
  const profile = {
    id: "zcode-fixture",
    name: "ZCode",
    command: new URL("../support/zcode-stdio-fixture.mjs", import.meta.url).pathname,
    providerConfig,
    builtinConfig: providerConfig,
    providerId: "fixture",
    model: "glm-fixture",
    efforts: ["high"],
    defaultEffort: "high",
  };
  const metadata = new SQLiteHarnessMetadata(":memory:");
  cleanups.push(async () => metadata.close());
  const driver = {} as Parameters<typeof harnessProfiles>[1];
  const registry = new HarnessRegistry(
    metadata,
    harnessProfiles(root, driver, {
      PATH: process.env.PATH,
      PANDA_FORCE_ZCODE_HARNESS_PROFILES: JSON.stringify([profile]),
    }),
  );
  await registry.initialize();
  const scope = join(root, "scratch");
  const port = applicationRuntimes({
    registry,
    scratchRoot: scope,
    principal: async () => administrator,
    codex() {
      throw Error("Unexpected Codex execution");
    },
  });
  expect((await port.catalog(administrator.owner)).runtimes.map(({ id }) => id)).not.toContain(profile.id);
  expect((await port.catalog(administrator.owner, "bots")).runtimes.map(({ id }) => id)).toContain(profile.id);
  expect((await port.catalog(administrator.owner, true)).runtimes.map(({ id }) => id)).toContain(profile.id);
  expect((await port.catalog(administrator.owner, "creation")).runtimes.map(({ id }) => id)).toContain(profile.id);
  const selection = { runtimeId: profile.id, model: profile.model, effort: "high" };
  await expect(port.resolve(administrator.owner, selection)).rejects.toMatchObject({ code: "capabilityUnavailable" });
  expect(await port.resolve(administrator.owner, selection, "bots")).toEqual(selection);
  const calls: string[] = [];
  for (const [purpose, tool] of [
    ["bots", "panda_bot_decide"],
    ["bot-chat", "panda_bot_chat_reply"],
    ["creation", "panda_creation_turn"],
  ] as const) {
    const result = await port.engine(administrator.owner, selection, root, purpose).run(
      {
        instructions: "Follow operator instructions.",
        prompt: "Untrusted task data",
        tools: [{ name: tool, description: "Scoped tool", inputSchema: { type: "object" } }],
      },
      {
        signal: new AbortController().signal,
        started() {},
        async call({ name }) {
          calls.push(name);
          return { success: true, text: "ok" };
        },
      },
    );
    expect(result.status).toBe("completed");
  }
  expect(calls).toEqual(["panda_bot_decide", "panda_bot_chat_reply", "panda_creation_turn"]);
  expect(await readdir(scope)).toEqual([]);
  const runtime = await registry.require(administrator, profile.id);
  await registry.configure(administrator, {
    ...runtime,
    botEnabled: false,
  });
  expect((await port.catalog(administrator.owner, "bots")).runtimes.map(({ id }) => id)).not.toContain(profile.id);
  expect((await port.catalog(administrator.owner, "creation")).runtimes.map(({ id }) => id)).toContain(profile.id);
  expect(await port.resolve(administrator.owner, selection, "creation")).toEqual(selection);
  expect((await port.catalog(administrator.owner, true)).runtimes.map(({ id }) => id)).toContain(profile.id);
  await expect(port.resolve(administrator.owner, selection, "bots")).rejects.toMatchObject({
    code: "capabilityUnavailable",
  });
  await expect(port.discover(administrator.owner, selection.runtimeId, "bots")).rejects.toMatchObject({
    code: "capabilityUnavailable",
  });
  const { botEnabled: _botEnabled, ...current } = await registry.require(administrator, profile.id);
  await registry.configure(administrator, { ...current, name: "Renamed ZCode" });
  expect((await registry.require(administrator, profile.id)).botEnabled).toBe(false);
  const other = "second-zcode";
  await registry.configure(administrator, {
    ...current,
    id: other,
    revision: 0,
    name: "Second ZCode",
  });
  expect((await port.catalog(administrator.owner, "bots")).runtimes.map(({ id }) => id)).toContain(other);
  await expect(registry.remove(administrator, other, 0)).rejects.toMatchObject({ code: "conflict" });
  const removed = await registry.remove(administrator, other, 1);
  expect(removed.runtimes.map(({ id }) => id)).not.toContain(other);
  expect(await registry.remove(administrator, other, 1)).toEqual(removed);
  await expect(registry.require(administrator, other)).rejects.toMatchObject({ code: "notFound" });
});

test("ZCode verifies native access before each new or resumed session can run", async () => {
  const { ZCodeHarnessAgent } = await import("../../src/server/harness/adapters/zcode.js");
  const cwd = await temporary();
  const providerConfig = join(cwd, "provider.json");
  const agent = async (settings: object) => {
    await writeFile(providerConfig, JSON.stringify(settings));
    const value = new ZCodeHarnessAgent({
      cwd,
      command: new URL("../support/zcode-stdio-fixture.mjs", import.meta.url).pathname,
      env: { PATH: process.env.PATH, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfig },
      providerId: "fixture",
      model: "fixture",
      cleanup: async () => {},
    });
    cleanups.push(() => value.close());
    return value;
  };
  const opened = await agent({});
  expect((await opened.initialize()).capabilities.permissionModes).toEqual(["ask", "full-access"]);
  const session = await opened.create(cwd, { permissionMode: "full-access" });
  const run = async (value: typeof opened, native: typeof session) => {
    let answer = "";
    await value.prompt(
      native,
      { text: "test", attachments: [], model: null, effort: null, operationId: randomUUID() },
      async (event) => {
        if (event.type === "text") answer += event.text;
      },
    );
    return answer;
  };
  expect(await run(opened, session)).toBe("Fixture ZCode yolo active.");
  const resumed = await agent({ projectionMode: "build" });
  expect(await run(resumed, await resumed.load(session.id, cwd, { permissionMode: "full-access" }))).toBe(
    "Fixture ZCode yolo active.",
  );
  const restored = await agent({ resumedMode: "yolo" });
  expect(await run(restored, await restored.load(session.id, cwd))).toBe("Fixture ZCode build active.");
  const unsupported = await agent({ ignoreMode: true });
  await expect(unsupported.load(session.id, cwd, { permissionMode: "full-access" })).rejects.toMatchObject({
    code: "capabilityUnavailable",
  });
  const elevated = await agent({ resumedMode: "yolo", ignoreMode: true });
  await expect(elevated.load(session.id, cwd)).rejects.toMatchObject({ code: "capabilityUnavailable" });
});

describe("Codex Harness adapter lifecycle", () => {
  test("applies the selected native approval and sandbox policies on every resumed turn", async () => {
    const { CodexHarnessAgent } = await import("../../src/server/harness/adapters/codex.js");
    type Driver = import("../../src/shared/engine/contracts.js").EngineDriver;
    let listener: Parameters<Driver["subscribe"]>[0] | undefined;
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const driver = {
      subscribe(fn: Parameters<Driver["subscribe"]>[0]) {
        listener = fn;
        return () => {};
      },
      sessions: { resume: async () => ({ id: "native", cwd: "/workspace" }) },
      execute: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "session.create") return { thread: { id: "native", cwd: "/workspace" } };
        listener!({
          kind: "notification",
          envelope: {
            method: "turn/completed",
            params: { threadId: "native", turn: { id: "turn", status: "completed" } },
          },
        });
        return { turn: { id: "turn", status: "completed" } };
      },
    } as unknown as Driver;
    const agent = new CodexHarnessAgent(driver);
    const turn = {
      text: "hello",
      attachments: [],
      model: null,
      effort: null,
      operationId: randomUUID(),
      visualEvidence: [{ mimeType: "image/png" as const, base64: "AA==" }],
    };
    for (const permissionMode of ["full-access", "ask"] as const) {
      const session = await agent.load("native", "/workspace", { permissionMode });
      await agent.prompt(session, turn, async () => {});
      const input = calls.at(-1)!.params;
      expect(input.input).toEqual([
        { type: "text", text: "hello" },
        { type: "image", url: "data:image/png;base64,AA==" },
      ]);
      expect(input.approvalPolicy).toBe(permissionMode === "full-access" ? "never" : "on-request");
      expect(input.sandboxPolicy).toEqual(
        permissionMode === "full-access"
          ? { type: "dangerFullAccess" }
          : {
              type: "workspaceWrite",
              writableRoots: ["/workspace"],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
      );
    }
    const previous = calls.length;
    const session = await agent.load("native", "/workspace");
    await expect(
      agent.prompt(
        session,
        {
          ...turn,
          beforeDispatch: async () => {
            throw new HarnessPromptError("conflict", false, 409);
          },
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "conflict", dispatched: false });
    expect(calls.length).toBe(previous);
    await expect(agent.load("native", "/workspace", { permissionMode: "always-approve" })).rejects.toMatchObject({
      code: "capabilityUnavailable",
    });
    await agent.close();
  });
  test("retains a verified terminal event when the dispatch acknowledgement is lost", async () => {
    const { CodexHarnessAgent } = await import("../../src/server/harness/adapters/codex.js");
    type Driver = import("../../src/shared/engine/contracts.js").EngineDriver;
    let listener: Parameters<Driver["subscribe"]>[0] | undefined;
    const calls: string[] = [],
      deltas: string[] = [];
    const driver = {
      subscribe(fn: Parameters<Driver["subscribe"]>[0]) {
        listener = fn;
        return () => {};
      },
      sessions: { resume: async () => ({ id: "native", cwd: "/workspace" }) },
      execute: async (method: string) => {
        calls.push(method);
        listener!({
          kind: "notification",
          envelope: { method: "item/agentMessage/delta", params: { threadId: "native", delta: "Confirmed reply" } },
        });
        listener!({
          kind: "notification",
          envelope: {
            method: "turn/completed",
            params: { threadId: "native", turn: { id: "turn", status: "completed" } },
          },
        });
        await Promise.resolve();
        throw Error("Dispatch acknowledgement lost");
      },
    } as unknown as Driver;
    const agent = new CodexHarnessAgent(driver),
      session = await agent.load("native", "/workspace");
    const result = await agent.prompt(
      session,
      { text: "Hello", attachments: [], model: null, effort: null, operationId: randomUUID() },
      async (event) => {
        if (event.type === "text") deltas.push(event.text);
      },
    );
    expect(result.stopReason).toBe("complete");
    expect(deltas).toEqual(["Confirmed reply"]);
    expect(calls).toEqual(["input.start"]);
    await agent.close();
  });
});
