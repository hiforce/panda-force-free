import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { legacyHistoryFixture } from "../support/legacy-history-fixture.js";
import { LegacyProjectDocuments } from "../../src/server/project-content/migration/legacy-documents.js";
import { inventoryLegacyProjectHistory } from "../../src/server/content-migration/history/inventory.js";
import { EditorialRepository } from "../../src/server/editorial/repository.js";
import { EditorialJobRepository } from "../../src/server/editorial/jobs/repository.js";
import { digest } from "../../src/server/delivery/digest.js";
import { WorkflowRepository } from "../../src/server/delivery/storage/workflows.js";
import { legacyMetadataFixture } from "../support/legacy-metadata-fixture.js";

test("offline history preflight preserves original channel, review, build and publication bytes without activating or dispatching", async () => {
  const f = await legacyHistoryFixture();
  try {
    const first = await f.inspect(),
      second = await f.inspect(),
      result = first.result;
    expect(first.after).toEqual(first.before);
    expect(result.projectId).toBe(f.f.space.projectId);
    expect(result.records.filter((row) => row.table === "publication_variants")).toHaveLength(1);
    expect(result.records.filter((row) => row.table === "publication_reviews")).toHaveLength(1);
    expect(result.records.filter((row) => row.table === "editorial_proposals")).toHaveLength(2);
    expect(result.records.filter((row) => row.table === "editorial_applications")).toHaveLength(1);
    expect(result.records.filter((row) => row.table === "editorial_history")).toHaveLength(2);
    expect(result.records.filter((row) => row.table === "site_builds")).toHaveLength(1);
    expect(result.records.filter((row) => row.table === "publication_plans")).toHaveLength(2);
    expect(result.records.filter((row) => row.table === "publication_snapshots")).toHaveLength(1);
    expect(result.records).toEqual(second.result.records);
    expect(result.digest).toBe(second.result.digest);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        { kind: "unconfirmed-plan", id: f.social.plan.id, state: "prepared" },
        { kind: "unconfirmed-plan", id: f.plan.id, state: "prepared" },
      ]),
    );
    expect(f.f.requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("One original");
    expect(JSON.stringify(result)).not.toContain("Original output");
    const snapshot = await LegacyProjectDocuments.open(first.path, f.f.space.projectId);
    try {
      expect(() => snapshot.inspect((queries) => queries.query("DELETE FROM publication_plans").get())).toThrow(
        "invalidFile",
      );
    } finally {
      snapshot.close();
    }
    expect(await readFile(first.path)).toEqual(first.before);
  } finally {
    await f.close();
  }
}, 30000);

test("unsettled edits, queued model jobs and active builds remain explicit migration blockers", async () => {
  const f = await legacyHistoryFixture();
  try {
    const p = f.pendingProposal;
    new EditorialRepository(f.db).reserve({
      proposalId: p.proposal.id,
      digest: p.digest,
      source: p.proposal.source,
      selected: [p.proposal.edits[0]!.id],
      reviewer: "owner",
      appliedAt: Date.now(),
    });
    const id = randomUUID();
    new EditorialJobRepository(f.db).create(
      "owner",
      "request",
      {
        schema: 1,
        id,
        proposalId: randomUUID(),
        source: { ref: p.proposal.source },
        mode: "proofread",
        profile: { id: "offline", engine: "fixture", model: "fixture", version: "1" },
      },
      Date.now(),
    );
    // Seed an offline historical state without reviving a terminal build through the live repository.
    f.db
      .query("UPDATE site_builds SET record=?,terminal=0 WHERE id=?")
      .run(JSON.stringify({ ...f.builds.get(f.build.id), phase: "running" }), f.build.id);
    const { result } = await f.inspect();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        { kind: "unsettled-edit", id: p.proposal.id, state: "intent-without-receipt" },
        { kind: "active-edit", id, state: "queued" },
        { kind: "active-build", id: f.build.id, state: "running" },
      ]),
    );
    expect(f.f.requests).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

test("unknown external results retain original pending intents and prevent cutover instead of retrying publication", async () => {
  const f = await legacyHistoryFixture();
  try {
    await f.f.submit(f.social);
    await f.f.feature.idle();
    expect((await f.f.feature.service.detail("owner", "x-post", f.social.plan.id)).phase).toBe("needsAttention");
    const before = f.f.requests.length,
      { result } = await f.inspect();
    expect(result.blockers).toEqual(
      expect.arrayContaining([{ kind: "unknown-effect", id: f.social.plan.id, state: "needsAttention" }]),
    );
    expect(result.blockers.some((row) => row.kind === "unknown-effect" && row.state.startsWith("pending-step:"))).toBe(
      true,
    );
    expect(result.records.filter((row) => row.table === "publication_confirmations")).toHaveLength(1);
    expect(f.f.requests).toHaveLength(before);
  } finally {
    await f.close();
  }
}, 30000);

test("project scoping excludes another project's history and cannot accept a forged source reference", async () => {
  const f = await legacyHistoryFixture();
  try {
    const clean = await f.inspect();
    const foreign = await LegacyProjectDocuments.open(clean.path, "foreign-project");
    try {
      expect(inventoryLegacyProjectHistory(foreign).records).toEqual([]);
    } finally {
      foreign.close();
    }
    const bad = await f.editBackup((db) => {
      const row = db
        .query<{ payload: string; sourceSnapshot: string }, [string]>(
          "SELECT payload,sourceSnapshot FROM publication_variants WHERE id=?",
        )
        .get(f.variant.variant.id)!;
      const value = JSON.parse(row.payload);
      value.source.revisionId = randomUUID();
      const ir = JSON.parse(row.sourceSnapshot);
      ir.revisionId = value.source.revisionId;
      const payload = JSON.stringify(value),
        sourceSnapshot = JSON.stringify(ir);
      db.query("UPDATE publication_variants SET revisionId=?,payload=?,sourceSnapshot=?,digest=? WHERE id=?").run(
        value.source.revisionId,
        payload,
        sourceSnapshot,
        digest(payload + "\n" + sourceSnapshot),
        f.variant.variant.id,
      );
    });
    const source = await LegacyProjectDocuments.open(bad, f.f.space.projectId);
    try {
      expect(() => inventoryLegacyProjectHistory(source)).toThrow("invalidFile");
    } finally {
      source.close();
    }
  } finally {
    await f.close();
  }
}, 30000);

for (const change of [
  "variant-digest",
  "review-digest",
  "proposal-digest",
  "missing-history",
  "new-schema",
  "missing-table",
  "partial-intent",
] as const)
  test(
    "history preflight refuses " + change + " without modifying the backup",
    async () => {
      const f = await legacyHistoryFixture();
      try {
        const path = await f.editBackup((db) => {
          if (change === "variant-digest") db.exec("UPDATE publication_variants SET payload='{}'");
          if (change === "review-digest") db.exec("UPDATE publication_reviews SET payload='{}'");
          if (change === "proposal-digest") db.exec("UPDATE editorial_proposals SET payload='{}'");
          if (change === "missing-history") db.exec("DELETE FROM editorial_history");
          if (change === "new-schema") db.exec("UPDATE publication_delivery_schema SET version=999");
          if (change === "missing-table") db.exec("DROP TABLE publication_confirmations");
          if (change === "partial-intent")
            db.exec("ALTER TABLE publication_delivery_schema RENAME TO undisclosed_delivery_schema");
        });
        const before = await readFile(path),
          source = await LegacyProjectDocuments.open(path, f.f.space.projectId);
        try {
          expect(() => inventoryLegacyProjectHistory(source)).toThrow(
            change === "new-schema" ? "unsupportedSchema" : "invalidFile",
          );
        } finally {
          source.close();
        }
        expect(await readFile(path)).toEqual(before);
      } finally {
        await f.close();
      }
    },
    30000,
  );

test("a standalone history snapshot rejects newly active journals and is inaccessible after close", async () => {
  const f = await legacyHistoryFixture();
  try {
    const path = await f.backup();
    await writeFile(path + "-wal", Buffer.from("active"));
    await expect(LegacyProjectDocuments.open(path, f.f.space.projectId)).rejects.toThrow("invalidFile");
    const fresh = await f.backup(),
      source = await LegacyProjectDocuments.open(fresh, f.f.space.projectId);
    const queries = source.inspect((read) => read),
      statement = queries.query("SELECT id FROM documents"),
      iterator = statement.iterate();
    source.close();
    expect(() => inventoryLegacyProjectHistory(source)).toThrow("unavailable");
    expect(() => queries.query("SELECT id FROM documents")).toThrow("unavailable");
    expect(() => statement.get()).toThrow("unavailable");
    expect(() => iterator.next()).toThrow("unavailable");
    expect(f.f.requests).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

test("a historical explicit recovery keeps its original pending row and rejects contradictory adoption evidence", async () => {
  const f = await legacyHistoryFixture();
  try {
    await f.f.submit(f.social);
    await f.f.feature.idle();
    const store = new WorkflowRepository(f.db, "x-post"),
      record = store.get(f.social.plan.id),
      step = record.steps.find((row) => row.outcome === "pending")!,
      captured = store.recovery.capture("owner", record.plan.id, step.id),
      evidence = store.recovery.record("owner", record.plan.id, step.id, captured.stateToken, {
        status: "match",
        result: { id: "401" },
        details: { fixture: true },
      });
    store.recovery.adopt("owner", record.plan.id, evidence.id, () => {});
    const requests = f.f.requests.length,
      { result } = await f.inspect();
    expect(result.blockers.filter((row) => row.id === record.plan.id)).toEqual([]);
    expect(result.records.filter((row) => row.table === "publication_resolutions")).toHaveLength(1);
    expect(store.get(record.plan.id).steps.find((row) => row.id === step.id)?.outcome).toBe("pending");
    expect(f.f.requests).toHaveLength(requests);
    const path = await f.editBackup((db) => {
        db.query("UPDATE publication_recovery_evidence SET status='mismatch' WHERE id=?").run(evidence.id);
      }),
      source = await LegacyProjectDocuments.open(path, f.f.space.projectId);
    try {
      expect(() => inventoryLegacyProjectHistory(source)).toThrow("invalidFile");
    } finally {
      source.close();
    }
  } finally {
    await f.close();
  }
}, 30000);

test("pre-recovery delivery schema retains a pending step as unknown without querying absent newer tables", async () => {
  const f = await legacyHistoryFixture();
  try {
    await f.f.submit(f.social);
    await f.f.feature.idle();
    const path = await f.editBackup((db) => {
        for (const table of [
          "publication_successors",
          "publication_resolutions",
          "publication_recovery_evidence",
          "publication_cancellations",
          "publication_observations",
          "publication_confirmations",
        ])
          db.exec("DROP TABLE " + table);
        db.exec("UPDATE publication_delivery_schema SET version=3");
      }),
      source = await LegacyProjectDocuments.open(path, f.f.space.projectId);
    try {
      const result = inventoryLegacyProjectHistory(source);
      expect(result.schemas.publication_delivery_schema).toBe(3);
      expect(result.blockers.some((row) => row.id === f.social.plan.id && row.state.startsWith("pending-step:"))).toBe(
        true,
      );
    } finally {
      source.close();
    }
  } finally {
    await f.close();
  }
}, 30000);

test("old document-only installations inventory successfully without bootstrapping consumer schemas", async () => {
  const f = await legacyMetadataFixture();
  const before = await readFile(f.path),
    source = await LegacyProjectDocuments.open(f.path, "project-1");
  try {
    const result = inventoryLegacyProjectHistory(source);
    expect(result.records).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(Object.values(result.schemas)).toEqual([0, 0, 0, 0]);
    expect(await readFile(f.path)).toEqual(before);
  } finally {
    source.close();
    await f.close();
  }
});

for (const [table, column] of [
  ["publication_variants", "sourceProjectId"],
  ["editorial_proposals", "sourceProjectId"],
  ["site_builds", "projectId"],
  ["publication_plans", "sourceProjectId"],
] as const)
  test(
    "mixed native " + table + " history cannot disappear through legacy selection filters",
    async () => {
      const f = await legacyHistoryFixture();
      try {
        const path = await f.editBackup((db) => {
            db.query("UPDATE " + table + " SET " + column + "=?").run(f.f.space.projectId);
            if (table === "publication_variants")
              db.query("UPDATE publication_variants SET documentId=?").run(randomUUID());
          }),
          source = await LegacyProjectDocuments.open(path, f.f.space.projectId);
        try {
          expect(() => inventoryLegacyProjectHistory(source)).toThrow("conflict");
        } finally {
          source.close();
        }
      } finally {
        await f.close();
      }
    },
    30000,
  );
