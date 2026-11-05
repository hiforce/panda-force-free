import { expect, test } from "bun:test";
import { browserEnvelope } from "../../src/server/protocol/browser.js";
import { nativeEnvelope, threadFromResult } from "../../src/server/protocol/native.js";
import { parseRollout } from "../../src/server/conversation/live-session.js";

test("protocol boundaries reject malformed owned data and preserve opaque provider extensions", () => {
  for (const params of [{ threadId: 42 }, { input: [{ type: "image" }] }, { limit: "20" }, []])
    expect(() => browserEnvelope({ type: "rpc", method: "turn/start", params })).toThrow();
  expect(
    browserEnvelope({
      type: "rpc",
      method: "turn/start",
      params: { threadId: "one", input: [{ type: "text", text: "Hello" }], providerExtension: { custom: true } },
    }).params.providerExtension,
  ).toEqual({ custom: true });
  for (const params of [{ threadId: 42 }, { item: { id: "one" } }, { turn: { id: 42 } }])
    expect(() => nativeEnvelope({ method: "item/completed", params })).toThrow();
  expect(() => nativeEnvelope({ method: "thread/status/changed", params: { status: { type: 42 } } })).toThrow();
  expect(
    nativeEnvelope({ method: "goal/status/changed", params: { status: "active", goalId: "native-goal" } }).params
      ?.status,
  ).toBe("active");
  expect(
    threadFromResult({
      thread: {
        id: "one",
        cwd: "/tmp",
        turns: [
          {
            id: "turn",
            status: "completed",
            items: [null, { id: "item", type: "agentMessage", text: "Native output" }],
          },
        ],
      },
    })?.turns[0].items[0].text,
  ).toBe("Native output");
});
test("malformed rollout records cannot mutate current turn state", () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: 42 } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "valid" } },
    { type: "event_msg", payload: { type: "user_message", local_images: { path: "bad" } } },
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ text: "Visible native output" }] },
    },
  ];
  const state = parseRollout(records.map((record) => JSON.stringify(record)).join("\n"));
  expect(state.active).toBe(true);
  expect(state.turn?.id).toBe("valid");
  expect(state.turn?.items[0].text).toBe("Visible native output");
});

test("metadata records preserve journal adjacency for repeated user input", () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "one" } },
    { type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "user_message", message: "repeat" } },
    { type: "turn_context", timestamp: "2026-01-01T00:00:01Z", payload: { cwd: "/tmp" } },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:03Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "repeat" }] },
    },
  ];
  const state = parseRollout(records.map((record) => JSON.stringify(record)).join("\n"));
  expect(state.userSequence).toBe(2);
  expect(state.eventSequence).toBe(4);
});
