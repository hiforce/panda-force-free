import { expect, test } from "bun:test";
import { KnowledgeCatalogReconciler } from "../../src/server/knowledge/catalog/reconcile.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { knowledgeCatalogFixture } from "../support/knowledge-catalog-fixture.js";

test("a real file/Git knowledge result is not admitted without completed workflow delivery", async () => {
  const f = await knowledgeCatalogFixture();
  try {
    expect(f.catalog.list(f.owner, f.admission.project).entries).toEqual([]);
    expect(f.catalog.save(f.admission, f.projection)).toBeFalse();
    expect(f.projection.sources).toHaveLength(2);
    const original = new Map(
      (await f.documents.snapshots.entries(f.input.sourceCommit)).map((entry) => [entry.path, entry.blob]),
    );
    for (const source of f.projection.sources) expect(original.get(projectDocumentFile(source.id))).toBe(source.blob);
    f.complete();
    const listed = f.catalog.list(f.owner, f.admission.project);
    expect(listed.incomplete).toBeFalse();
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]!.projection).toEqual(f.projection);
    expect(f.catalog.list("another-member", f.admission.project).entries).toHaveLength(1);
    expect(f.catalog.list(f.owner, "another-project").entries).toEqual([]);
    expect(JSON.stringify(f.db.query("SELECT projection FROM knowledge_catalog").get())).not.toContain(
      "Durable storage is required",
    );
  } finally {
    await f.close();
  }
}, 20000);
test("catalog insertion and delivery completion roll back together and retry idempotently", async () => {
  const f = await knowledgeCatalogFixture();
  try {
    f.db.exec(
      "CREATE TEMP TRIGGER block_catalog BEFORE INSERT ON knowledge_catalog BEGIN SELECT RAISE(ABORT,'catalog fault');END",
    );
    expect(() => f.complete()).toThrow("catalog fault");
    expect(f.ledger.get(f.owner, f.admission.taskId).state).toBe("committing");
    expect(f.catalog.list(f.owner, f.admission.project).entries).toEqual([]);
    f.db.exec("DROP TRIGGER block_catalog");
    f.complete();
    f.complete();
    expect(f.ledger.get(f.owner, f.admission.taskId).state).toBe("completed");
    expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM knowledge_catalog").get()!.n).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);
test("missing or damaged derived catalog metadata is rebuilt without approving or rewriting knowledge", async () => {
  const f = await knowledgeCatalogFixture(),
    errors: unknown[] = [],
    reconciler = new KnowledgeCatalogReconciler(f.catalog, f.files, f.content, (error) => errors.push(error));
  async function repaired() {
    const deadline = Date.now() + 5000;
    while (!f.catalog.current(f.admission)) {
      if (Date.now() > deadline) throw Error("Metadata repair did not complete");
      await Bun.sleep(20);
    }
  }
  try {
    f.complete();
    const before = f.ledger.get(f.owner, f.admission.taskId),
      head = await f.documents.snapshots.head();
    f.db.exec("DELETE FROM knowledge_catalog");
    reconciler.start();
    await repaired();
    f.db.query("UPDATE knowledge_catalog SET projection='{}'").run();
    const damaged = f.catalog.list(f.owner, f.admission.project);
    expect(damaged.incomplete).toBeTrue();
    expect(damaged.entries).toEqual([]);
    reconciler.request(damaged.missing);
    await repaired();
    expect(f.ledger.get(f.owner, f.admission.taskId)).toEqual(before);
    expect(await f.documents.snapshots.head()).toBe(head);
    expect(errors).toEqual([]);
    expect(f.catalog.current({ ...f.admission, inputDigest: "b".repeat(64) })).toBeNull();
  } finally {
    await reconciler.close();
    await f.close();
  }
}, 20000);
