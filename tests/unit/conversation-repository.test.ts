import { describe, expect, test } from "bun:test";
import { createConversationRepository } from "../../src/client/conversation-repository.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const thread = (id = "a", status = "completed") => ({
  id,
  updatedAt: Date.now() / 1000,
  history: { revision: "r1" },
  turns: [{ id: "t1", status, items: [] }],
});
function fixture(overrides = {}) {
  const writes = [];
  const persistent = {
    get: async () => null,
    put: async (value) => {
      writes.push(value);
      return true;
    },
    prune: async () => [],
    remove: async () => {},
    clear: async () => {},
    summaries: async () => [],
    saveSummaries: async () => {},
    ...overrides,
  };
  return { repository: createConversationRepository({ persistent }), writes };
}
describe("conversation repository lifecycle", () => {
  test("cannot resurrect a deleted session from an in-flight persistent read", async () => {
    const read = deferred(),
      { repository } = fixture({ get: () => read.promise });
    const pending = repository.load("a");
    await repository.remove("a");
    read.resolve(thread());
    expect(await pending).toBeNull();
    expect(repository.has("a")).toBe(false);
  });
  test("logout invalidates pending history and sidebar reads", async () => {
    const read = deferred(),
      rows = deferred(),
      { repository } = fixture({ get: () => read.promise, summaries: () => rows.promise });
    const pending = repository.load("a"),
      summaries = repository.summaries();
    await repository.clear();
    read.resolve(thread());
    rows.resolve([{ id: "a" }]);
    expect(await pending).toBeNull();
    expect(await summaries).toEqual([]);
  });
  test("prefers live data received while a disk read was pending", async () => {
    const read = deferred(),
      { repository } = fixture({ get: () => read.promise });
    const pending = repository.load("a"),
      live = thread("a", "inProgress");
    repository.remember(live);
    read.resolve(thread());
    expect(await pending).toBe(live);
  });
  test("deduplicates writes but persists status changes sharing a history revision", async () => {
    const { repository, writes } = fixture();
    repository.remember(thread());
    repository.remember(thread());
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    repository.remember(thread("a", "inProgress"));
    await Promise.resolve();
    expect(writes).toHaveLength(2);
  });
  test("retries a failed persistence write and limits memory to eight sessions", async () => {
    let attempts = 0;
    const { repository } = fixture({ put: async () => ++attempts > 1 });
    repository.remember(thread());
    await Promise.resolve();
    repository.remember(thread());
    await Promise.resolve();
    expect(attempts).toBe(2);
    for (let i = 0; i < 9; i++) repository.remember(thread(String(i)));
    expect(repository.has("a")).toBe(false);
    expect(repository.has("0")).toBe(false);
    expect(repository.has("8")).toBe(true);
  });
  test("does not evict freshly replaced memory when an older prune finishes", async () => {
    const pruning = deferred(),
      { repository } = fixture({ prune: () => pruning.promise });
    repository.remember(thread());
    const pending = repository.prune(),
      fresh = thread("a", "inProgress");
    repository.remember(fresh);
    pruning.resolve(["a"]);
    await pending;
    expect(repository.get("a")).toBe(fresh);
  });
});
