import { expect, test } from "bun:test";
import { KnowledgeRecords, unavailableApprovedKnowledge } from "../../src/server/knowledge/catalog/read.js";
import type { ApprovedKnowledgeReader } from "../../src/server/knowledge/catalog/contracts.js";
test("unavailable approved storage fails explicitly and never masquerades as an empty catalog", async () => {
  await expect(
    new KnowledgeRecords(unavailableApprovedKnowledge()).detail("owner", { project: "project", id: "knowledge" }),
  ).rejects.toMatchObject({ code: "unavailable" });
});
test("approved record reads bound owner and total work and release capacity after failed reads", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((done) => {
      release = done;
    }),
    reader: ApprovedKnowledgeReader = {
      head: async () => "unused",
      snapshot: async () => ({ commit: "unused", records: [] }),
      current: async () => {
        await held;
        return [];
      },
    },
    records = new KnowledgeRecords(reader, { perOwner: 1, total: 2 }),
    input = { project: "project", id: "knowledge" },
    alice = records.detail("alice", input).catch((error) => error),
    bob = records.detail("bob", input).catch((error) => error);
  try {
    await expect(records.detail("alice", input)).rejects.toMatchObject({ code: "budget", status: 429 });
    await expect(records.detail("carol", input)).rejects.toMatchObject({ code: "budget", status: 429 });
    release();
    expect(await alice).toMatchObject({ code: "notFound" });
    expect(await bob).toMatchObject({ code: "notFound" });
    await expect(records.detail("alice", input)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    release();
    await Promise.all([alice, bob]);
  }
});
