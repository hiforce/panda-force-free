import { expect, test } from "bun:test";
import { latestTokenUsage, tokenUsage } from "../../src/shared/engine/usage.ts";
import { parseRollout, LiveSessionStore } from "../../src/server/conversation/live-session.js";
import { appendFileSync, closeSync, ftruncateSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadHub } from "../../src/server/conversation/thread-hub.ts";
import { createStateDomains } from "../../src/client/application/state-domains.ts";
import { createSessionState } from "../../src/client/application/session-state.ts";

const info = {
  total_token_usage: { total_tokens: 14000, input_tokens: 12000, output_tokens: 2000, cached_input_tokens: 5000 },
  last_token_usage: { total_tokens: 4000, input_tokens: 3500, output_tokens: 500 },
  model_context_window: 200000,
};
const event = (value: unknown = info) =>
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-11-06T00:00:00Z",
    payload: { type: "token_count", info: value },
  }) + "\n";

test("portable counters retain zero and reject invalid provider values", () => {
  expect(tokenUsage({ total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })?.total?.totalTokens).toBe(0);
  for (const value of [
    null,
    {},
    { total: {} },
    { total: { totalTokens: "200" } },
    { last: { totalTokens: -1 } },
    { total: { totalTokens: Infinity } },
  ])
    expect(tokenUsage(value)).toBeUndefined();
  expect(
    tokenUsage({ total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, totalTokens: 110 } })?.total
      ?.totalTokens,
  ).toBe(110);
});

test("usage freshness rejects late history while allowing explicitly newer rollback counters", () => {
  const current = { total: { totalTokens: 1200 }, updatedAt: 2000 };
  expect(latestTokenUsage(current, { total: { totalTokens: 1100 }, updatedAt: 1000 })).toEqual(current);
  expect(latestTokenUsage(current, { total: { totalTokens: 1100 }, updatedAt: 3000 })?.total?.totalTokens).toBe(1100);
  expect(latestTokenUsage(current, { total: { totalTokens: 1000 } })).toEqual(current);
  expect(latestTokenUsage(undefined, current)).toEqual(current);
  expect(latestTokenUsage(current, undefined)).toEqual(current);
});

test("one session repository hydrates history, protects live usage and isolates session selection", () => {
  const domains = createStateDomains({});
  const sessions = createSessionState(domains.scope("sessionStore"));
  const state = domains.scope("diagnostics").state;
  sessions.replaceActive({ id: "alpha", tokenUsage: { total: { totalTokens: 100 }, updatedAt: 1000 } });
  expect(state.tokenUsage.get("alpha")?.total?.totalTokens).toBe(100);
  sessions.recordTokenUsage("alpha", { total: { totalTokens: 200 }, updatedAt: 2000 });
  sessions.replaceActive({ id: "alpha", tokenUsage: { total: { totalTokens: 100 }, updatedAt: 1000 } });
  expect(state.active?.tokenUsage?.total?.totalTokens).toBe(200);
  sessions.recordTokenUsage("beta", { total: { totalTokens: 80 }, updatedAt: 3000 });
  expect(state.active?.tokenUsage?.total?.totalTokens).toBe(200);
  sessions.replaceActive({ id: "beta" });
  expect(state.active?.tokenUsage?.total?.totalTokens).toBe(80);
  sessions.replaceActive({ id: "missing" });
  expect(state.active?.tokenUsage).toBeUndefined();
});

test("journal usage is independent of visible turns and survives null information records", () => {
  const state = parseRollout(event() + event(null));
  expect(state.turn).toBeNull();
  expect(state.tokenUsage?.total?.totalTokens).toBe(14000);
  expect(state.tokenUsage?.total?.cachedInputTokens).toBe(5000);
  expect(state.tokenUsage?.last?.totalTokens).toBe(4000);
  expect(state.tokenUsage?.modelContextWindow).toBe(200000);
  expect(state.tokenUsage?.updatedAt).toBe(Date.parse("2026-11-06T00:00:00Z"));
});

test("bounded journal reads and native item pagination restore usage after reader restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-history-")),
    path = join(directory, "rollout.jsonl");
  const fd = openSync(path, "w");
  ftruncateSync(fd, 2 * 1024 ** 3);
  closeSync(fd);
  appendFileSync(path, "\n" + event());
  try {
    for (let restart = 0; restart < 2; restart++) {
      const live = new LiveSessionStore({ maxReadBytes: 4096 }).read(path);
      expect(live.tokenUsage?.total?.totalTokens).toBe(14000);
      const calls: string[] = [];
      const hub = createThreadHub({
        sharedMode: true,
        defaultSessionsRoot: directory,
        reviewDiffs: { record: () => {} },
        request: async (method) => {
          calls.push(method);
          if (method === "thread/list") return { data: [{ id: "usage-session", path, cwd: directory }] };
          if (method === "thread/items/list") return { data: [], nextCursor: null };
          if (method === "thread/turns/list") return { data: [] };
          throw Error("Unbounded read: " + method);
        },
      });
      const result = await hub.readConversationHistory({ threadId: "usage-session", limit: 20 });
      expect(result.thread.tokenUsage?.total?.totalTokens).toBe(14000);
      expect(calls).not.toContain("thread/read");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
