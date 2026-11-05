import { expect, test } from "bun:test";
import { mkdtempSync, openSync, ftruncateSync, closeSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadHub } from "../../src/server/conversation/thread-hub.ts";
import { mergeConversationHistory } from "../../src/client/ui-core.js";

test("completed host questionnaires survive native history omissions, pagination and reader restart", async () => {
  for (const large of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "completed-question-")),
      path = join(directory, "rollout.jsonl");
    const fd = openSync(path, "w");
    if (large) ftruncateSync(fd, 9 * 1024 * 1024);
    closeSync(fd);
    const question = {
      id: "question",
      type: "function_call",
      name: "request_user_input_async",
      arguments: JSON.stringify({ questions: [{ title: "Choose", options: ["A", "B"] }] }),
    };
    appendFileSync(
      path,
      "\n" +
        [
          { type: "event_msg", payload: { type: "task_started", turn_id: "question-turn" } },
          { type: "response_item", payload: question },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "question-turn" } },
          { type: "event_msg", payload: { type: "task_started", turn_id: "later-turn" } },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "later-turn" } },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") +
        "\n",
    );
    const turn = {
      id: "question-turn",
      status: "completed",
      items: [{ id: "reply", type: "agentMessage", text: "Question sent" }],
    };
    const makeHub = () =>
      createThreadHub({
        sharedMode: true,
        defaultSessionsRoot: directory,
        reviewDiffs: { record: () => {} },
        request: async (method) => {
          if (method === "thread/list") return { data: [{ id: "thread", path, cwd: directory }] };
          if (method === "thread/read") return { thread: { id: "thread", path, cwd: directory, turns: [turn] } };
          if (method === "thread/items/list")
            return { data: [{ turnId: turn.id, item: turn.items[0] }], nextCursor: null };
          if (method === "thread/turns/list") return { data: [{ id: turn.id, status: "completed", items: [] }] };
          throw Error(method);
        },
      });
    try {
      for (let restart = 0; restart < 2; restart++) {
        const hub = makeHub();
        const first = await hub.readConversationHistory({ threadId: "thread", limit: 20 });
        let merged = mergeConversationHistory(null, first);
        expect(merged.turns[0].items.some((item) => item.id === "question")).toBe(true);
        expect(merged.turns[0].status).toBe("completed");
        const delta = await hub.readConversationHistory({
          threadId: "thread",
          limit: 20,
          revision: merged.history.revision,
          oldestItemId: merged.history.oldestItemId,
        });
        merged = mergeConversationHistory(merged, delta);
        expect(merged.turns[0].items.filter((item) => item.id === "question")).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("large thread/read and metadata requests never read the full native journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bounded-thread-"));
  const path = join(directory, "large.jsonl");
  const fd = openSync(path, "w");
  ftruncateSync(fd, 2 * 1024 * 1024 * 1024);
  closeSync(fd);
  const calls: any[] = [];
  const hub = createThreadHub({
    sharedMode: true,
    defaultSessionsRoot: directory,
    reviewDiffs: { record: () => {} },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/list")
        return { data: [{ id: "large", path, cwd: directory, canAcceptDirectInput: true }] };
      if (method === "thread/items/list")
        return {
          data: [{ turnId: "turn", item: { id: "item", type: "agentMessage", text: "latest" } }],
          nextCursor: null,
        };
      if (method === "thread/turns/list") return { data: [{ id: "turn", status: "inProgress", items: [] }] };
      throw new Error(`Unbounded native operation: ${method}`);
    },
  });
  try {
    const result = await hub.readBrowserThread({ threadId: "large", includeTurns: true });
    expect(result.thread.turns[0].items.map((item) => item.id)).toEqual(["item"]);
    expect(result.history.nativePages).toBe(true);
    expect(result.thread.history.revision).toBeTruthy();
    hub.recordThreadStatus("large", { type: "active", activeFlags: [] });
    expect((await hub.getThreadMetadata("large")).status.type).toBe("active");
    hub.recordThreadStatus("large", { type: "idle" });
    expect((await hub.getThreadMetadata("large")).status.type).toBe("idle");
    const previousCalls = calls.length;
    const metadata = await hub.readBrowserThread({ threadId: "large", includeTurns: false });
    expect(metadata.thread.cwd).toBe(directory);
    expect(metadata.thread.turns).toEqual([]);
    expect(calls).toHaveLength(previousCalls);
    expect(calls.some((call) => call.method === "thread/read" || call.method === "thread/resume")).toBe(false);
    expect(calls.find((call) => call.method === "thread/turns/list").params.itemsView).toBe("notLoaded");
    expect(calls.find((call) => call.method === "thread/items/list").params.limit).toBe(1);
    const turns = await hub.readBrowserTurns({ threadId: "large", limit: 1, itemsView: "full" });
    expect(turns.data[0].items.map((item) => item.id)).toEqual(["item"]);
    expect(
      calls
        .filter((call) => call.method === "thread/turns/list")
        .every((call) => call.params.itemsView === "notLoaded"),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
