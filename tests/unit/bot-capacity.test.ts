import { expect, test } from "bun:test";
import { BotStore } from "../../src/server/bots/store.js";
import { botQueueQuery } from "../../src/server/bots/queue-query.js";
import { botTaskData } from "../../src/server/bots/task-record.js";

const input = (id: string, text = "Record " + id) => ({
  externalTaskId: id,
  instructions: "Review the record",
  input: { text, images: [] },
});
test("paged Bot history searches beyond 200 records and counts lifecycle states without loading bodies", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "capacity", name: "Reviewer" });
    for (let i = 0; i < 360; i++) {
      const task = store.submit(
        bot,
        input(
          "record-" + i,
          i === 2
            ? JSON.stringify({ externalTaskId: "large-id", title: "A clear product title", secret: "private input" })
            : "Record " + i,
        ),
        "idem-" + i,
      ).task;
      task.status = i < 300 ? "kept" : "queued";
      store.db.query("UPDATE bot_tasks SET data=?,status=? WHERE id=?").run(botTaskData(task), task.status, task.id);
    }
    const page = store.queue("alice", botQueueQuery(new URLSearchParams("page=2&limit=25")));
    expect(page.tasks).toHaveLength(25);
    expect(page.total).toBe(360);
    expect(page.tasks[0]!.externalTaskId).toBe("record-334");
    expect(page.counts.finished).toBe(300);
    expect(page.counts.created).toBe(60);
    const result = store.queue("alice", botQueueQuery(new URLSearchParams("q=A+clear+product&filter=completed")));
    expect(result.total).toBe(1);
    expect(result.tasks[0]!.summary).toBe("A clear product title");
    expect(JSON.stringify(result)).not.toContain("private input");
    expect(store.queue("bob").total).toBe(0);
    expect(store.queue("alice", botQueueQuery(new URLSearchParams("q=100%25"))).total).toBe(0);
    expect(
      store.db
        .query("EXPLAIN QUERY PLAN SELECT * FROM bot_events WHERE taskId=? ORDER BY rowid")
        .all("task")
        .some((row: any) => row.detail.includes("bot_events_task")),
    ).toBe(true);
    expect(() => botQueueQuery(new URLSearchParams("limit=99999"))).toThrow("invalidInput");
  } finally {
    store.close();
  }
});
test("bounded claims reach eligible Bots behind a large paused queue and preserve session protection on restart", () => {
  const store = new BotStore(":memory:");
  try {
    const paused = store.createBot("alice", { code: "paused", name: "Paused" }),
      ready = store.createBot("alice", { code: "ready", name: "Ready" });
    store.updateBot("alice", paused.id, { active: false });
    for (let i = 0; i < 800; i++) store.submit(paused, input("paused-" + i, "x".repeat(32000)), "p" + i);
    const accepted = store.submit(ready, input("eligible"), "eligible").task;
    const claim = store.claim();
    expect(claim?.task.id).toBe(accepted.id);
    expect(store.claim()).toBeNull();
    store.saveBot({ ...ready, sessionId: "internal-session-1" });
    store.saveBot({ ...ready, sessionId: "internal-session-2" });
    expect(store.db.query("SELECT id FROM bot_sessions ORDER BY id").all()).toHaveLength(2);
    expect(store.hasSession("internal-session-1")).toBe(true);
  } finally {
    store.close();
  }
});
test("queue backpressure admits idempotent retries at capacity and rejects new work", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "backpressure", name: "Capacity" });
    for (let i = 0; i < 1000; i++) store.submit(bot, input("task-" + i), "key-" + i);
    expect(store.submit(bot, input("task-0"), "key-0").duplicate).toBe(true);
    expect(() => store.submit(bot, input("overflow"), "overflow")).toThrow("queueFull");
  } finally {
    store.close();
  }
});

test("retention defaults to five days, respects owner settings and preserves pending work and replay protection", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "retention", name: "Retention" }),
      other = store.createBot("bob", { code: "other-retention", name: "Other" }),
      now = Date.now();
    const seed = (agent: typeof bot, id: string, status: string, age: number) => {
      const task = store.submit(agent, input(id), id).task;
      task.updatedAt = now - age * 86400000;
      store.db
        .query("UPDATE bot_tasks SET data=?,status=? WHERE id=?")
        .run(botTaskData({ ...task, status: status as any }), status, task.id);
      return task;
    };
    const expired = seed(bot, "expired", "kept", 6),
      recent = seed(bot, "recent", "kept", 4),
      queued = seed(bot, "queued", "queued", 8),
      running = seed(bot, "running", "running", 8),
      review = seed(bot, "review", "review", 8),
      unknown = seed(bot, "unknown", "callback_unknown", 8),
      retained = seed(other, "retained", "discarded", 8);
    expect(store.retention("alice").days).toBe(5);
    store.setRetention("bob", 10);
    expect(store.cleanup(now)).toBe(1);
    expect(() => store.task("alice", expired.id)).toThrow("notFound");
    expect(store.events("alice", recent.id)).toHaveLength(1);
    for (const task of [queued, running, review, unknown]) expect(store.task("alice", task.id).id).toBe(task.id);
    expect(store.task("bob", retained.id).id).toBe(retained.id);
    expect(store.db.query("SELECT count(*) n FROM bot_events WHERE taskId=?").get(expired.id)).toEqual({ n: 0 });
    expect(() => store.submit(bot, input("expired"), "expired")).toThrow("taskDeleted");
    expect(() => store.setRetention("alice", 0)).toThrow("invalidInput");
  } finally {
    store.close();
  }
});

test("optional task titles remain distinct from content summaries and older clients stay compatible", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "titles", name: "Titles" });
    const task = store.submit(
      bot,
      { ...input("titled", "Detailed source content"), title: "Review a new product" },
      "titled",
    ).task;
    expect(task.title).toBe("Review a new product");
    expect(store.queue("alice").tasks[0]!.title).toBe("Review a new product");
    expect(store.queue("alice", botQueueQuery(new URLSearchParams("q=new+product"))).total).toBe(1);
    store.submit(bot, input("old", "Legacy content without a title"), "old");
    const legacy = store.queue("alice").tasks[0]!;
    expect(legacy.title).toBeUndefined();
    expect(legacy.summary).toBe("Legacy content without a title");
  } finally {
    store.close();
  }
});

test("history pagination anchors prevent new arrivals from shifting the next page", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "pages", name: "Pages" });
    for (let i = 0; i < 60; i++) store.submit(bot, input("page-" + i), "key-" + i);
    const first = store.queue("alice", botQueueQuery(new URLSearchParams("limit=25")));
    for (let i = 60; i < 80; i++) store.submit(bot, input("page-" + i), "key-" + i);
    const second = store.queue(
      "alice",
      botQueueQuery(new URLSearchParams({ limit: "25", page: "2", anchor: String(first.anchor) })),
    );
    expect(second.total).toBe(60);
    expect(second.tasks[0]!.externalTaskId).toBe("page-34");
    expect(store.queue("alice").total).toBe(80);
  } finally {
    store.close();
  }
});
test("high-rate key authentication throttles usage writes while revocation remains immediate", () => {
  const store = new BotStore(":memory:");
  try {
    const bot = store.createBot("alice", { code: "auth-capacity", name: "Auth" }),
      key = store.issue("alice", { name: "Capacity", botIds: [bot.id] });
    const before = store.db.query<{ n: number }, []>("SELECT total_changes() n").get()!.n;
    for (let i = 0; i < 1500; i++) expect(store.authenticate(key.secret).owner).toBe("alice");
    expect(store.db.query<{ n: number }, []>("SELECT total_changes() n").get()!.n - before).toBe(1);
    store.revoke("alice", key.key.id);
    expect(() => store.authenticate(key.secret)).toThrow("unauthorized");
  } finally {
    store.close();
  }
});
