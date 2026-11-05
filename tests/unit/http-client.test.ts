import { expect, test } from "bun:test";
import { createHttpClient } from "../../src/client/http-client.js";
import { createLifecycle } from "../../src/client/lifecycle.js";
import { matchesRequestOrigin } from "../../src/server/auth/origin.js";

test("authentication observes the first same-origin failure without replacing fetch; disposal cannot remove a newer observer", async () => {
  const fetch = globalThis.fetch;
  const client = createHttpClient({
    fetchImpl: async () => new Response(null, { status: 401 }),
    origin: () => "https://example.test",
  });
  let first = 0,
    second = 0;
  const unsubscribe = client.observeAuthentication(() => {
    first++;
  });
  expect((await client.request("https://example.test/api/test")).status).toBe(401);
  await Promise.resolve();
  expect(first).toBe(1);
  await client.request("https://other.test/api/test");
  expect(first).toBe(1);
  const unsubscribeNew = client.observeAuthentication(() => {
    second++;
  });
  unsubscribe();
  await client.request("https://example.test/api/test");
  await Promise.resolve();
  expect(second).toBe(1);
  unsubscribeNew();
  await client.request("https://example.test/api/test");
  expect(second).toBe(1);
  expect(globalThis.fetch).toBe(fetch);
});
test("feature lifecycle disposal removes listeners and pending timers exactly once", async () => {
  const owner = createLifecycle(),
    target = new EventTarget();
  let events = 0,
    timers = 0;
  owner.on(target, "example", () => events++);
  owner.timeout(() => timers++, 1);
  target.dispatchEvent(new Event("example"));
  owner.dispose();
  owner.dispose();
  target.dispatchEvent(new Event("example"));
  owner.timeout(() => timers++, 1);
  await Bun.sleep(10);
  expect(events).toBe(1);
  expect(timers).toBe(0);
});
test("shared origin parsing preserves strict OIDC scheme and local host policies", () => {
  expect(
    matchesRequestOrigin({
      hostHeader: "example.test",
      origin: "https://example.test",
      expectedOrigin: "https://example.test",
    }),
  ).toBe(true);
  expect(
    matchesRequestOrigin({
      hostHeader: "example.test",
      origin: "http://example.test",
      expectedOrigin: "https://example.test",
    }),
  ).toBe(false);
  expect(matchesRequestOrigin({ hostHeader: "localhost:8899", origin: "http://localhost:8899" })).toBe(true);
  for (const origin of [
    "null",
    "https://example.test/",
    "https://example.test.attacker.test",
    "https://user@example.test",
  ])
    expect(matchesRequestOrigin({ hostHeader: "example.test", origin })).toBe(false);
  expect(matchesRequestOrigin({ hostHeader: "example.test", fetchSite: "cross-site" })).toBe(false);
});

test("an authentication observer failure cannot turn a completed HTTP response into a network error", async () => {
  const client = createHttpClient({
    fetchImpl: async () => new Response(null, { status: 401 }),
    origin: () => "https://example.test",
  });
  client.observeAuthentication(() => {
    throw new Error("Observer failure");
  });
  expect((await client.request("https://example.test/api/test")).status).toBe(401);
  await Bun.sleep(0);
});
