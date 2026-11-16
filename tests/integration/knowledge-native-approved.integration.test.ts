import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeKnowledgeFixture } from "../support/native-knowledge-fixture.js";
import { FileOriginalQueries } from "../../src/server/content-sources/reader.js";
import { extractCreativeText } from "../../src/server/creative/assets/projection.js";
import { KnowledgeCatalogReconciler } from "../../src/server/knowledge/catalog/reconcile.js";
import { FileApprovedKnowledgeReader } from "../../src/server/knowledge/integration/approved-reader.js";

for (const kind of ["web", "slides"] as const) {
  test(`${kind} approved knowledge requires completed workflow admission and exact native evidence`, async () => {
    const f = await nativeKnowledgeFixture(kind);
    try {
      const reader = f.reader();
      expect(await reader.current(f.scope, [f.record.id])).toEqual([]);
      expect((await reader.snapshot(f.scope)).records).toEqual([]);
      f.complete();
      const head = await reader.head(f.scope),
        value = (await reader.current(f.scope, [f.record.id]))[0]!;
      expect(value.record).toEqual(f.record);
      expect(value.sources).toEqual([
        {
          ...f.projection.sources[0],
          title: "Verified native source",
          path: kind === "web" ? "guide.html" : "guide.pptx",
          ancestors: [],
        },
      ]);
      expect(await reader.snapshot(f.scope)).toEqual({ commit: head, records: [value] });
      expect(JSON.stringify(value)).not.toContain("Hidden script");
      await f.app.creations.setState(
        "alice",
        "project-1",
        f.saved.asset.id,
        f.saved.asset.version,
        "trashed",
        randomUUID(),
      );
      expect(await reader.head(f.scope)).not.toBe(head);
      expect(await reader.current(f.scope, [f.record.id])).toEqual([]);
      expect(f.catalog.current(f.admission)).not.toBeNull();
    } finally {
      await f.close();
    }
  }, 30000);
}

test("native knowledge hydration verifies current resource bytes and permission without changing admission", async () => {
  const f = await nativeKnowledgeFixture();
  try {
    f.complete();
    const reader = f.reader(),
      head = await reader.head(f.scope);
    await writeFile(
      join(f.assetRoot, "projects", "project-1", "blobs", f.saved.asset.resources[0]!.digest),
      "Tampered resource",
    );
    expect(await reader.head(f.scope)).toBe(head);
    await expect(reader.current(f.scope, [f.record.id])).rejects.toBeTruthy();
    f.grants.clear();
    await expect(reader.current(f.scope, [f.record.id])).rejects.toMatchObject({ code: "notFound" });
    expect(f.ledger.get(f.scope.owner, f.record.taskId).state).toBe("completed");
  } finally {
    await f.close();
  }
}, 30000);

for (const change of ["independent", "source", "permission"] as const) {
  test(`native approved parsing holds no writer lease and fences an overlapping ${change} change`, async () => {
    const f = await nativeKnowledgeFixture();
    let enter!: () => void,
      release!: () => void,
      parses = 0;
    const entered = new Promise<void>((resolve) => (enter = resolve)),
      paused = new Promise<void>((resolve) => (release = resolve));
    let pending: Promise<unknown> | undefined;
    try {
      f.complete();
      const reader = f.reader(
        new FileOriginalQueries(f.app.projectContent, f.assetRoot, async (...args) => {
          parses++;
          enter();
          await paused;
          return extractCreativeText(...args);
        }),
      );
      await reader.head(f.scope);
      expect(parses).toBe(0);
      pending = reader.current(f.scope, [f.record.id]);
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entered;
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        release();
      }, 5000);
      try {
        if (change === "independent") {
          await f.project.coordinator.mutate({
            operationId: randomUUID(),
            author: { name: "Writer", email: "writer@example.test" },
            message: "Save independent content",
            changes: [{ path: "knowledge/independent.md", content: "An independent write.\n" }],
          });
        } else if (change === "source") {
          await f.app.creations.setState(
            "alice",
            "project-1",
            f.saved.asset.id,
            f.saved.asset.version,
            "trashed",
            randomUUID(),
          );
        } else f.grants.clear();
        expect(timedOut).toBe(false);
        release();
        const result = await settled;
        if (change === "independent") expect("value" in result && result.value).toHaveLength(1);
        else expect("error" in result).toBe(true);
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      release();
      await pending?.catch(() => {});
      await f.close();
    }
  }, 30000);
}

test("native approved catalog repairs metadata from completed Git delivery without approving or rewriting content", async () => {
  const f = await nativeKnowledgeFixture(),
    errors: unknown[] = [],
    reconciler = new KnowledgeCatalogReconciler(f.catalog, f.files, f.content, (error) => errors.push(error));
  try {
    f.complete();
    const task = f.ledger.get(f.scope.owner, f.record.taskId),
      head = await f.snapshots.head();
    f.db.exec("DELETE FROM knowledge_catalog");
    const reader = new FileApprovedKnowledgeReader(
      f.catalog,
      async () => f.app.projectContent,
      (missing) => reconciler.request(missing),
      async () => f.app.originals,
    );
    await expect(reader.current(f.scope, [f.record.id])).rejects.toMatchObject({ code: "unavailable" });
    const deadline = Date.now() + 15000;
    while (!f.catalog.current(f.admission)) {
      if (Date.now() > deadline) throw Error("Native catalog repair did not complete");
      await Bun.sleep(20);
    }
    expect(errors).toEqual([]);
    expect((await reader.current(f.scope, [f.record.id]))[0]!.record).toEqual(f.record);
    expect(f.ledger.get(f.scope.owner, f.record.taskId)).toEqual(task);
    expect(await f.snapshots.head()).toBe(head);
  } finally {
    await reconciler.close();
    await f.close();
  }
}, 30000);
