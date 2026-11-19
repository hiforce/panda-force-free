import { afterEach, beforeEach, expect, test } from "bun:test";
import { CreationApiError, creationApiFor } from "../../src/client/creation/api.js";

const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const id = "9a3ce0ac-c79a-4c42-aad2-f80c83be1c35";
let events = 0;
let calls: { path: string; method: string }[];
beforeEach(() => {
  calls = [];
  events = 0;
  const target = new EventTarget();
  target.addEventListener("panda-force:creation-changed", () => events++);
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
});
afterEach(() => {
  Object.defineProperty(globalThis, "fetch", fetchDescriptor);
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});
function respond(command: number | Error, task: object, readStatus = 200) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, options: RequestInit) => {
      calls.push({ path, method: options.method! });
      if (options.method === "POST") {
        if (command instanceof Error) throw command;
        return Response.json(command === 200 ? { task } : { code: "conflict" }, { status: command });
      }
      return Response.json({ task }, { status: readStatus });
    },
  });
}
test("a successful cancellation needs no confirmation request", async () => {
  respond(200, { id, state: "cancelled", cancelRequested: true });
  expect((await creationApiFor("personal").cancel(id)).task.state).toBe("cancelled");
  expect(calls).toHaveLength(1);
  expect(events).toBe(1);
});
for (const error of [409, 503, new TypeError("Lost response"), new DOMException("Timed out", "TimeoutError")]) {
  test("an uncertain cancellation confirms the authoritative stopped task: " + String(error), async () => {
    respond(error, { id, state: "cancelled", cancelRequested: true });
    expect((await creationApiFor("personal").cancel(id)).task.state).toBe("cancelled");
    expect(calls).toEqual([
      { path: "/api/personal/document-creations/cancel", method: "POST" },
      { path: `/api/personal/document-creations/detail?id=${id}&view=progress`, method: "GET" },
    ]);
    expect(events).toBe(1);
  });
}
test("a real conflict with a running task remains an error", async () => {
  respond(409, { id, state: "running", cancelRequested: false });
  await expect(creationApiFor().cancel(id)).rejects.toBeInstanceOf(CreationApiError);
  expect(events).toBe(0);
  expect(calls).toHaveLength(2);
});
test("authentication failures do not trigger a second request", async () => {
  respond(403, { id, state: "cancelled", cancelRequested: true });
  await expect(creationApiFor().cancel(id)).rejects.toBeInstanceOf(CreationApiError);
  expect(calls).toHaveLength(1);
  expect(events).toBe(0);
});
test("failed confirmation preserves the original error and never repeats the command", async () => {
  respond(409, { id, state: "running" }, 503);
  await expect(creationApiFor().cancel(id)).rejects.toMatchObject({ status: 409 });
  expect(calls).toHaveLength(2);
  expect(events).toBe(0);
});
test("a different task cannot confirm the cancellation", async () => {
  respond(409, { id: "other", state: "cancelled", cancelRequested: true });
  await expect(creationApiFor().cancel(id)).rejects.toMatchObject({ status: 409 });
  expect(events).toBe(0);
});
test("completion racing cancellation keeps its actual successful state", async () => {
  respond(409, { id, state: "succeeded", cancelRequested: false });
  expect((await creationApiFor().cancel(id)).task.state).toBe("succeeded");
  expect(events).toBe(1);
});
