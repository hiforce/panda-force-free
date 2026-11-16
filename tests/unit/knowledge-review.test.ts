import { expect, test } from "bun:test";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { knowledgeReviewStore } from "../../src/server/knowledge/storage/review-store.js";
import { knowledgeReviewVerdict } from "../../src/shared/knowledge/review.js";

const draft = {
    schema: 1 as const,
    title: "Durability",
    summary: "Write durable data.",
    claims: [{ id: "c1", kind: "source" as const, text: "Use durable storage.", evidence: [] }],
    uncertainties: [],
  },
  verdict = {
    schema: 1,
    verdict: "approve",
    summary: "Every claim is supported.",
    checks: { faithfulness: true, coverage: true, separation: true, clarity: true, contradictions: true },
    claims: [{ id: "c1", supported: true, reason: "The selected source supports it." }],
    issues: [],
  };

test("automatic approval requires every semantic check and claim, not a confidence score or matching citation alone", () => {
  expect(() =>
    knowledgeReviewVerdict(verdict, { ...draft, claims: [{ ...draft.claims[0]!, kind: "inference" }] }),
  ).toThrow("invalidInput");
  expect(knowledgeReviewVerdict(verdict, draft).verdict).toBe("approve");
  expect(() => knowledgeReviewVerdict({ ...verdict, confidence: 1 }, draft)).toThrow("invalidInput");
  expect(() => knowledgeReviewVerdict({ ...verdict, claims: [] }, draft)).toThrow("invalidInput");
  expect(() => knowledgeReviewVerdict({ ...verdict, claims: [...verdict.claims, ...verdict.claims] }, draft)).toThrow(
    "invalidInput",
  );
  expect(() => knowledgeReviewVerdict({ ...verdict, claims: [{ ...verdict.claims[0], id: "other" }] }, draft)).toThrow(
    "invalidInput",
  );
  expect(() =>
    knowledgeReviewVerdict({ ...verdict, checks: { ...verdict.checks, faithfulness: false } }, draft),
  ).toThrow("invalidInput");
  expect(() => knowledgeReviewVerdict({ ...verdict, issues: ["Unresolved contradiction"] }, draft)).toThrow(
    "invalidInput",
  );
  expect(() => knowledgeReviewVerdict(verdict, { ...draft, uncertainties: ["Is this accurate?"] })).toThrow(
    "invalidInput",
  );
});

test("policy changes fence a completed review before admission; expired reviewers cannot overlap generation or silently retry", () => {
  const db = openKnowledgeDatabase(":memory:"),
    tasks = knowledgeTaskLedger(db),
    reviews = knowledgeReviewStore(db);
  try {
    const create = (id: string) =>
      tasks.create(
        {
          owner: "owner",
          project: "p1",
          title: "Source",
          operationId: id,
          requestHash: id,
          signature: id,
          inputDigest: "a".repeat(64),
          dialogueDigest: "b".repeat(64),
        },
        1000,
      );
    const task = create("task-one"),
      generation = tasks.claim(1001, 10000)!;
    tasks.draft(tasks.bind(generation.lease, { sessionId: "s1", runId: "r1" }, 1002), "c".repeat(64), 1003);
    expect(reviews.claim(1004)).toBeNull();
    reviews.configure("owner", "p1", true, 0, 1005);
    const claim = reviews.claim(1006)!,
      bound = reviews.bind(claim.review, { sessionId: "review-s1", runId: "review-r1" }, 1007);
    create("task-two");
    expect(tasks.claim(1008, 1000)).toBeNull();
    reviews.finish(bound, "d".repeat(64), true, 1009);
    const passed = reviews.latest("owner", task.id)!;
    reviews.configure("owner", "p1", false, 1, 1010);
    expect(() => reviews.admit(passed, "d".repeat(64), "e".repeat(64), 1011)).toThrow("conflict");
    expect(tasks.get("owner", task.id).state).toBe("review");
    expect(reviews.latest("owner", task.id)?.state).toBe("superseded");
    reviews.configure("owner", "p1", true, 2, 1012);
    const retry = reviews.claim(1013)!;
    expect(retry.review.id).not.toBe(bound.id);
    reviews.claim(40000);
    expect(reviews.latest("owner", task.id)?.state).toBe("failed");
    expect(() => reviews.bind(retry.review, { sessionId: "late", runId: "late" }, 40001)).toThrow("leaseLost");
    expect(reviews.claim(40002)).toBeNull();
  } finally {
    db.close();
  }
});
