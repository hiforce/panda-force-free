import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCreationMaterials } from "../../src/server/creation/integration/material-files.js";
import { createSkillFeature } from "../../src/server/skills/integration/feature.js";
import { createRouter } from "../../src/server/http/router.js";
import { BotStore } from "../../src/server/bots/store.js";
import { botChatContext } from "../../src/server/bots/workspace/chat-context.js";
import { BotChatService } from "../../src/server/bots/workspace/chat-service.js";
import { BotChatWorker } from "../../src/server/bots/workspace/chat-worker.js";
import { chatWrite } from "../../src/server/bots/workspace/chat-records.js";
import { createBotWorkspaceFeature } from "../../src/server/bots/workspace/feature.js";
import { HarnessError } from "../../src/shared/harness/contracts.js";

test("Bot chat freezes a Bot-only runtime and returns a definitive rejection before enqueue", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-chat-runtime-"));
  const store = new BotStore(":memory:");
  const selection = { runtimeId: "bot-only-fixture", model: "declared-model", effort: "high" };
  const bot = store.createBot("alice", { name: "Helper", code: "fixture-helper", ...selection });
  let available = false;
  let replyCount = 0;
  const feature = createBotWorkspaceFeature({
    stateRoot: root,
    version: "fixture",
    connection: { mode: "isolated" },
    store,
    owner: () => "alice",
    runtimes: {
      async catalog() {
        throw Error("Unexpected list");
      },
      async discover() {
        throw Error("Unexpected discovery");
      },
      async resolve(owner, current, scope) {
        expect(owner).toBe("alice");
        expect(current.runtimeId).toBe(selection.runtimeId);
        expect(scope).toBe("bots");
        if (!available) throw new HarnessError("capabilityUnavailable", 409);
        return selection;
      },
      engine(_, selected, __, purpose) {
        expect(selected.runtimeId).toBe(selection.runtimeId);
        expect(purpose).toBe("bot-chat");
        return {
          id: "scoped-runtime-fixture",
          async run(_, callbacks) {
            const run = { sessionId: "app-fixture", runId: "fixture-turn" };
            await callbacks.started(run);
            await callbacks.call({
              ...run,
              callId: "decision",
              name: "panda_bot_chat_reply",
              arguments: { text: "Scoped reply" },
            });
            replyCount++;
            return { ...run, status: "completed" };
          },
        };
      },
    },
  });
  const router = createRouter(feature.routes);
  const server = createServer((req, res) => void router({ req, res, url: new URL(req.url!, "http://localhost") }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const url = origin + "/api/bots/" + bot.id + "/chat";
  const submit = () => fetch(url, { method: "POST", headers: { Origin: origin }, body });
  const body = JSON.stringify({ requestId: randomUUID(), generation: 1, text: "Hello" });
  try {
    const rejected = await submit();
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: { code: "runtimeSelectionUnavailable" } });
    expect((await (await fetch(url)).json()).messages).toEqual([]);
    available = true;
    expect((await submit()).status).toBe(202);
    expect((await submit()).status).toBe(200);
    const service = new BotChatService(store);
    for (let attempt = 0; attempt < 100 && (await service.snapshot("alice", bot.id)).busy; attempt++)
      await Bun.sleep(10);
    const snapshot = await service.snapshot("alice", bot.id);
    expect(snapshot.messages.map(({ text }) => text)).toEqual(["Hello", "Scoped reply"]);
    expect(replyCount).toBe(1);
  } finally {
    await feature.close();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Bot chat binds real materials and immutable skill guidance to an idempotent message without document or task tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-chat-context-")),
    store = new BotStore(":memory:"),
    materials = new FileCreationMaterials(join(root, "materials")),
    skills = await createSkillFeature({ stateRoot: root, version: "0.1.0", owner: () => "alice" }),
    context = botChatContext(materials, skills.catalog),
    service = new BotChatService(store, context),
    router = createRouter(materials.routes((c) => String(c.req.headers["x-owner"] ?? "alice"), "/api/chat-materials")),
    server = createServer((req, res) => {
      void router({ req, res, url: new URL(req.url!, "http://localhost") });
    });
  const materialLocales: Array<string | undefined> = [],
    readMaterial = context.read;
  context.read = (owner, material, offset, locale) => {
    materialLocales.push(locale);
    return readMaterial(owner, material, offset, locale);
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port,
    upload = async (name: string, bytes: Uint8Array) => {
      const response = await fetch(base + "/api/chat-materials?" + new URLSearchParams({ name }), {
        method: "POST",
        headers: { Origin: base },
        body: bytes,
      });
      expect(response.status).toBe(201);
      return (await response.json()).attachment;
    };
  let worker: BotChatWorker | undefined,
    runs = 0;
  try {
    const file = await upload("reference.txt", Buffer.from("A fact supplied by the human.")),
      image = await upload(
        "reference.png",
        await readFile(new URL("../../public/assets/panda-icon.png", import.meta.url)),
      ),
      bot = store.createBot("alice", { name: "Private helper", code: "private-helper" }),
      pack = (await skills.catalog.list(undefined, 100)).packages.find(
        (p) => p.id === "panda-force.document-creation",
      )!,
      selection = { packageId: pack.id, version: pack.version, digest: pack.digest, id: "writing", parameters: {} },
      input = {
        requestId: randomUUID(),
        generation: 1,
        text: "Prepare a document here",
        attachments: [{ materialId: file.materialId }, { materialId: image.materialId }],
        selections: [selection],
      };
    expect((await fetch(base + file.url, { headers: { "x-owner": "bob" } })).status).toBe(404);
    const foreignBot = store.createBot("bob", { name: "Other helper", code: "other-helper" });
    await expect(service.send("bob", foreignBot.id, { ...input, requestId: randomUUID() })).rejects.toMatchObject({
      code: "chatContextUnavailable",
    });
    await expect(
      service.send("alice", bot.id, {
        ...input,
        requestId: randomUUID(),
        selections: [{ ...selection, digest: "f".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "chatContextUnavailable" });
    await expect(
      service.send("alice", bot.id, { ...input, requestId: randomUUID(), attachments: [{ path: "/etc/passwd" }] }),
    ).rejects.toMatchObject({ code: "chatContextUnavailable" });
    await service.send("alice", bot.id, input, "zh-TW");
    expect(await service.send("alice", bot.id, input)).toMatchObject({ duplicate: true });
    await expect(service.send("alice", bot.id, { ...input, attachments: [] })).rejects.toMatchObject({
      code: "idempotencyConflict",
    });
    const reply = "```markdown\n# A document in this conversation\n\nA fact supplied by the human.\n```";
    worker = new BotChatWorker(
      store,
      () => ({
        id: "context-fixture",
        async run(value, callbacks) {
          expect(value.tools.map((tool) => tool.name)).toEqual(["panda_bot_chat_reply", "panda_bot_chat_material"]);
          expect(value.instructions).toContain("Never save or archive it to a project");
          expect(value.prompt).toContain("selectedSkillGuidance");
          const run = ++runs;
          if (run === 1) expect(value.prompt).toContain(pack.digest);
          else {
            expect(value.sessionId).toBeUndefined();
            expect(value.prompt).toContain("Prepare a document here");
            expect(value.prompt).toContain('"selectedSkillGuidance":[]');
            expect(value.prompt).not.toContain(pack.digest);
          }
          const scope = { sessionId: "owned-human-session-" + run, runId: "owned-human-turn-" + run };
          await callbacks.started(scope);
          const call = (args: unknown, extra = {}) =>
            callbacks.call({
              ...scope,
              callId: randomUUID(),
              name: "panda_bot_chat_material",
              arguments: args,
              ...extra,
            });
          await expect(call({ id: randomUUID() })).rejects.toThrow();
          await expect(call({ id: file.materialId, path: "/etc/passwd" })).rejects.toThrow();
          await expect(call({ id: file.materialId }, { runId: "foreign-turn" })).rejects.toThrow();
          expect(JSON.parse((await call({ id: file.materialId })).text).content).toBe("A fact supplied by the human.");
          expect((await call({ id: image.materialId })).images?.[0]).toStartWith("data:image/png;base64,");
          await expect(
            callbacks.call({ ...scope, callId: randomUUID(), name: "panda_documents_create", arguments: {} }),
          ).rejects.toThrow();
          await callbacks.call({
            ...scope,
            callId: randomUUID(),
            name: "panda_bot_chat_reply",
            arguments: { text: reply },
          });
          return { ...scope, status: "completed" };
        },
      }),
      (id) => join(root, "chat", id),
      context,
    );
    await worker.tick();
    for (let i = 0; i < 400 && (await service.snapshot("alice", bot.id)).busy; i++) await Bun.sleep(10);
    const snapshot = await service.snapshot("alice", bot.id);
    expect(snapshot.busy).toBe(false);
    expect(materialLocales).toContain("zh-TW");
    expect(snapshot.messages[0]?.materials).toHaveLength(2);
    expect(snapshot.messages[0]?.skills?.[0]?.selection).toEqual(selection);
    expect(snapshot.messages[1]?.text).toBe(reply);
    expect(snapshot.messages[1]?.status).toBe("complete");
    expect(await store.tasks("alice")).toEqual([]);
    const old = await service.state("alice", bot.id);
    const legacy = { ...old.data, sessionId: "legacy-text-only" };
    delete legacy.toolset;
    await store.workspace.batch("alice", {
      checks: [{ kind: "chat", id: bot.id, version: old.version }],
      puts: [chatWrite(bot.id, legacy)],
    });
    await service.send("alice", bot.id, {
      requestId: randomUUID(),
      generation: 1,
      text: "Continue without the previous skills",
    });
    await worker.tick();
    for (let i = 0; i < 400 && (await service.snapshot("alice", bot.id)).busy; i++) await Bun.sleep(10);
    const upgraded = await service.state("alice", bot.id);
    expect(runs).toBe(2);
    expect(upgraded.data.toolset).toBe("materials-v1");
    expect(upgraded.data.sessionId).toBe("owned-human-session-2");
    expect(
      await store.workspace.get("alice", { kind: "cleanup", id: bot.id + ":engine:legacy-text-only" }),
    ).not.toBeNull();

    await service.clear("alice", bot.id, { requestId: randomUUID(), generation: 1 });
    await expect(service.send("alice", bot.id, input)).rejects.toMatchObject({ code: "staleConversation" });
  } finally {
    await worker?.close();
    await materials.close();
    skills.close();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
