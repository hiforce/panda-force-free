import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EditorialProposal, EditorialSourceRef } from "../../src/shared/editorial/contracts.js";
import { EditorialRepository } from "../../src/server/editorial/repository.js";
import { EditorialService } from "../../src/server/editorial/service.js";

const source: EditorialSourceRef = { documentId: "original", revisionId: "revision", sourceHash: "hash", version: 1 };
const originalMarker = "private-original-content:",
  replacementMarker = "private-replacement-content:";
const proposal = (createdAt = 100): EditorialProposal => ({
  schema: 1,
  id: randomUUID(),
  source,
  mode: "proofread",
  producer: { kind: "model", engine: "fixture", model: "editor", version: "1" },
  edits: [
    {
      id: "change",
      path: [0, 0],
      start: 0,
      end: 16000,
      before: originalMarker.repeat(1000).slice(0, 16000),
      after: replacementMarker.repeat(1000).slice(0, 16000),
      rule: "grammar",
    },
  ],
  truncated: false,
  createdAt,
});

test("review history reads small projections and stable pages without hydrating source, proposals or receipts", async () => {
  const db = new Database(":memory:");
  try {
    const repository = new EditorialRepository(db),
      service = new EditorialService(
        repository,
        {
          authorize: () => () => {},
          applied: () => null,
          current: () => source,
          revision() {
            throw Error("History must not hydrate source");
          },
          apply() {
            throw Error("History must not save source");
          },
        },
        new Map(),
      );
    const values = Array.from({ length: 52 }, () => proposal());
    values[51]!.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const item of values) repository.create("owner", "request-" + item.id, item);
    const detail = repository.get;
    repository.get = () => {
      throw Error("History must not hydrate proposals or receipts");
    };
    const first = await service.history("owner", "original");
    expect(first.reviews).toHaveLength(50);
    expect(first.reviews[0]!.id).toBe(values[51]!.id);
    expect(first.reviews[49]!.id).toBe(values[2]!.id);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(40000);
    expect(JSON.stringify(first)).not.toContain(originalMarker);
    expect(JSON.stringify(first)).not.toContain(replacementMarker);
    expect(JSON.stringify(first)).not.toContain('"edits"');
    expect(first.reviews.every((item) => !item.applied && !item.stale)).toBe(true);
    expect((await service.history("another-owner", "original")).reviews).toEqual([]);
    expect((await service.history("owner", "other-document")).reviews).toEqual([]);
    repository.get = detail;
    const newest = proposal(200);
    repository.create("owner", "newest", newest);
    repository.get = () => {
      throw Error("History must not hydrate proposals or receipts");
    };
    const second = await service.history("owner", "original", first.nextCursor);
    expect(second.reviews.map((item) => item.id)).toEqual([values[1]!.id, values[0]!.id]);
    expect(second.nextCursor).toBeNull();
    expect((await service.history("owner", "original")).reviews[0]!.id).toBe(newest.id);
    for (const cursor of [
      "invalid!",
      "",
      Buffer.from("[-1,1]").toString("base64url"),
      Buffer.from('[0,"x"]').toString("base64url"),
    ])
      await expect(service.history("owner", "original", cursor)).rejects.toThrow("invalidInput");
    db.query("UPDATE editorial_history SET payload=payload||' ' WHERE id=?").run(newest.id);
    await expect(service.history("owner", "original")).rejects.toThrow("unavailable");
  } finally {
    db.close();
  }
});

test("proposal and history projection are atomic, and applied status remains separate from immutable summaries", async () => {
  const db = new Database(":memory:");
  try {
    const repository = new EditorialRepository(db),
      item = proposal();
    db.exec(
      "CREATE TRIGGER reject_editorial_history BEFORE INSERT ON editorial_history BEGIN SELECT RAISE(ABORT,'history fixture failure'); END",
    );
    expect(() => repository.create("owner", "request", item)).toThrow("history fixture failure");
    expect(db.query("SELECT COUNT(*) AS count FROM editorial_proposals").get()).toEqual({ count: 0 });
    db.exec("DROP TRIGGER reject_editorial_history");
    const saved = repository.create("owner", "request", item);
    const service = new EditorialService(
      repository,
      {
        authorize: () => () => {},
        applied: () => null,
        current: () => source,
        revision() {
          throw Error("Not needed");
        },
        apply() {
          throw Error("Not needed");
        },
      },
      new Map(),
    );
    const before = await service.history("owner", "original");
    expect(before.reviews[0]!.applied).toBe(false);
    repository.apply(
      {
        proposalId: item.id,
        digest: saved.digest,
        source,
        selected: ["change"],
        applied: { ...source, version: 2, revisionId: "next" },
        reviewer: "owner",
        appliedAt: 200,
      },
      '["change"]',
    );
    expect((await service.history("owner", "original")).reviews[0]!.applied).toBe(true);
    expect(repository.create("owner", "request", item).proposal).toEqual(item);
    expect(db.query("SELECT COUNT(*) AS count FROM editorial_history").get()).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
