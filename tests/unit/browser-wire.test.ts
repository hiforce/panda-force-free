import { expect, test } from "bun:test";
import { createBrowserWire } from "../../src/server/bridge/browser-wire.js";

test("cached and current clients receive one event in their negotiated vocabulary", () => {
  const wire = createBrowserWire(),
    legacy = {},
    current = {};
  wire.register(current, true);
  const event = {
    type: "engine/request",
    payload: { id: "opaque-request", method: "approval", surface: { kind: "approval" } },
  };
  expect(JSON.parse(wire.stringify(current, event))).toEqual(event);
  expect(JSON.parse(wire.stringify(legacy, event))).toEqual({ ...event, type: "codex/request" });
  expect(event.type).toBe("engine/request");
  expect(JSON.parse(wire.stringify(legacy, { type: "__proto__" }))).toEqual({ type: "__proto__" });
  wire.register(current, false);
  expect(JSON.parse(wire.stringify(current, event)).type).toBe("codex/request");
});

test("wire compatibility preserves journal data, native text and unrelated reply types", () => {
  const wire = createBrowserWire(),
    client = {};
  const event = {
    type: "engine/notification",
    payload: { method: "item/agentMessage/delta", params: { delta: "Native text stays verbatim" } },
  };
  expect(JSON.parse(wire.stringify(client, event))).toEqual({ ...event, type: "codex/notification" });
  expect(JSON.parse(wire.stringify(client, { type: "rpc/result", result: event.payload }))).toEqual({
    type: "rpc/result",
    result: event.payload,
  });
});
