import { expect, test } from "bun:test";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotStore } from "../../src/server/bots/store.js";
import { prepareBotProfile } from "../../src/server/bots/profile.js";
import { BotWorker } from "../../src/server/bots/worker.js";
import { BOT_AVATAR_CHOICES } from "../../src/shared/bots/contracts.js";

test("animal avatars persist alongside default pandas and historical icons", () => {
  const store = new BotStore(":memory:");
  try {
    for (const icon of [...BOT_AVATAR_CHOICES, "compass"] as const) {
      const bot = store.createBot("alice", {
        name: icon,
        code: "avatar-" + icon,
        avatar: { type: "icon", icon, tone: "accent" },
      });
      expect(store.bot("alice", bot.id).avatar).toEqual({ type: "icon", icon, tone: "accent" });
    }
    const panda = store.createBot("alice", { name: "Default", code: "default-avatar" });
    expect(panda.avatar).toEqual({ type: "icon", icon: "panda", tone: "accent" });
  } finally {
    store.close();
  }
});

const persona = {
  role: "Product reviewer",
  traits: "Curious and careful",
  voice: "Warm, concise explanations",
  motto: "Details matter.",
};
async function upload(red = 20) {
  const bytes = await sharp({
    create: { width: 80, height: 60, channels: 4, background: { r: red, g: 100, b: 180, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return { type: "upload", data: "data:image/png;base64," + bytes.toString("base64") };
}

test("private avatar normalization, profile transactions and legacy records survive reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-profile-")),
    path = join(root, "bots.sqlite");
  let store = new BotStore(path);
  try {
    const legacy = store.createBot("alice", { name: "Legacy", code: "legacy-bot" }),
      legacyBytes = store.db.query<{ data: string }, [string]>("SELECT data FROM bots WHERE id=?").get(legacy.id)!.data;
    expect(legacy.avatar).toEqual({ type: "icon", icon: "panda", tone: "accent" });
    const original = await upload(),
      prepared = await prepareBotProfile("alice", { name: "Reviewer", code: "profile-bot", avatar: original, persona });
    const bot = store.configureBot("alice", prepared.value, undefined, prepared.image);
    expect(bot.persona).toEqual(persona);
    expect(bot.avatar?.type).toBe("image");
    const id = bot.avatar?.type === "image" ? bot.avatar.id : "";
    const normalized = store.avatars.read("alice", id),
      meta = await sharp(normalized).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
    expect(JSON.stringify(store.bots("alice"))).not.toContain("base64");
    expect(() => store.avatars.read("bob", id)).toThrow();
    expect(() => store.configureBot("bob", { avatar: { type: "image", id } }, legacy.id)).toThrow();
    const failed = await prepareBotProfile("alice", {
      name: "Duplicate",
      code: legacy.code,
      avatar: await upload(170),
    });
    expect(() => store.configureBot("alice", failed.value, undefined, failed.image)).toThrow();
    expect(store.db.query<{ n: number }, []>("SELECT count(*) n FROM bot_avatars").get()!.n).toBe(1);
    expect(() =>
      store.configureBot("alice", { name: "Changed", persona: { ...persona, traits: "x".repeat(2001) } }, bot.id),
    ).toThrow();
    expect(store.bot("alice", bot.id)).toEqual(bot);
    store.close();
    store = new BotStore(path);
    expect(store.bot("alice", legacy.id)).toEqual(legacy);
    expect(store.db.query<{ data: string }, [string]>("SELECT data FROM bots WHERE id=?").get(legacy.id)!.data).toBe(
      legacyBytes,
    );
    expect(store.bot("alice", bot.id)).toEqual(bot);
    expect(Buffer.from(store.avatars.read("alice", id))).toEqual(Buffer.from(normalized));
    const shared = store.configureBot("alice", { name: "Shared", code: "shared-bot", avatar: bot.avatar });
    store.configureBot("alice", { avatar: { type: "icon", icon: "shield", tone: "accent" } }, bot.id);
    expect(store.avatars.read("alice", id).length).toBeGreaterThan(0);
    store.configureBot("alice", { avatar: { type: "icon", icon: "bot", tone: "success" } }, shared.id);
    expect(() => store.avatars.read("alice", id)).toThrow();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("avatar and persona input reject remote resources, active content and oversized fields", async () => {
  const store = new BotStore(":memory:");
  try {
    for (const avatar of [
      { type: "image", id: "https://example.com/avatar" },
      { type: "icon", icon: "<svg>", tone: "accent" },
      { type: "icon", icon: "bot", tone: "url(foo)" },
    ])
      expect(() => store.createBot("alice", { name: "Bad", code: "bad-bot", avatar })).toThrow();
    for (const avatar of [
      { type: "upload", data: "data:image/svg+xml;base64," + Buffer.from("<svg><script/></svg>").toString("base64") },
      { type: "upload", data: "data:image/png;base64," + Buffer.from("not an image").toString("base64") },
      { type: "upload", data: "x".repeat(400001) },
    ])
      await expect(prepareBotProfile("alice", { avatar })).rejects.toThrow();
    expect(() =>
      store.createBot("alice", { name: "Bad", code: "bad-bot", persona: { role: "r", tools: ["http"] } }),
    ).toThrow();
  } finally {
    store.close();
  }
});

test("the real task worker uses persona without expanding tools or bypassing the decision contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-persona-")),
    store = new BotStore(":memory:");
  let seen = "",
    tools: string[] = [];
  const bot = store.createBot("alice", {
    name: "Reviewer",
    code: "persona-bot",
    instructions: "Do not invent product facts.",
    persona,
  });
  const task = store.submit(
    bot,
    {
      externalTaskId: "product-1",
      instructions: "Review this description",
      input: { text: "A simple visor.", images: [] },
    },
    "one",
  ).task;
  const worker = new BotWorker(
    store,
    () => ({
      id: "fixture",
      async run(input, hooks) {
        seen = input.instructions;
        tools = input.tools.map((tool) => tool.name);
        await hooks.session?.("profile-session");
        await hooks.started({ sessionId: "profile-session", runId: "profile-run" });
        await hooks.call({
          name: "panda_bot_decide",
          sessionId: "profile-session",
          runId: "profile-run",
          callId: "decision-1",
          arguments: { taskId: task.id, decision: "review", reason: "Source needed." },
        });
        return { status: "completed", sessionId: "profile-session", runId: "profile-run" };
      },
    }),
    root,
    async () => {
      throw new Error("No callback may be sent");
    },
  );
  try {
    worker.tick();
    const until = Date.now() + 5000;
    while (store.task("alice", task.id).status !== "review" && Date.now() < until) await Bun.sleep(10);
    expect(store.task("alice", task.id).status).toBe("review");
    expect(seen).toContain(persona.traits);
    expect(seen).toContain(persona.voice);
    expect(seen).toContain("Do not invent product facts.");
    expect(seen).toContain("never override task evidence");
    expect(seen).not.toContain(persona.motto);
    expect(tools).toEqual(["panda_bot_images", "panda_bot_decide"]);
  } finally {
    await worker.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Bot reasoning settings are bounded, owner scoped, atomic and durable without changing legacy records", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-effort-")),
    file = join(root, "bots.sqlite");
  let store = new BotStore(file);
  try {
    const legacy = store.createBot("alice", { name: "Legacy", code: "legacy-effort" });
    expect(legacy.effort).toBeUndefined();
    const bot = store.createBot("alice", { name: "Reasoning", code: "reasoning", model: "model-a", effort: "high" });
    expect(store.bot("alice", bot.id).effort).toBe("high");
    expect(() => store.updateBot("bob", bot.id, { effort: "low" })).toThrow("notFound");
    for (const effort of [null, 3, "bad\u0000level", "x".repeat(65)]) {
      expect(() => store.updateBot("alice", bot.id, { name: "Must not save", effort })).toThrow("invalidInput");
      expect(store.bot("alice", bot.id)).toEqual(bot);
    }
    store.updateBot("alice", bot.id, { effort: "" });
    store.close();
    store = new BotStore(file);
    expect(store.bot("alice", bot.id).effort).toBe("");
    expect(store.bot("alice", legacy.id)).toEqual(legacy);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("saving a legacy default effort preserves quota backoff unless reasoning actually changes", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { name: "Legacy retry", code: "legacy-retry" });
    store.saveBot({ ...bot, executionRetryAt: 123456 });
    expect(store.updateBot("alice", bot.id, { name: "Edited name", effort: "" }).executionRetryAt).toBe(123456);
    expect(store.updateBot("alice", bot.id, { effort: "high" }).executionRetryAt).toBeUndefined();
  } finally {
    store.close();
  }
});
