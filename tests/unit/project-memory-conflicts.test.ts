import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteHarnessMetadata } from "../../src/server/harness/storage/sqlite.js";
import { JsonlHarnessHistory } from "../../src/server/harness/storage/history.js";
import { save } from "../../src/server/harness/records.js";
import { ProjectMemory } from "../../src/server/project-memory/service.js";
import { evidenceKind, namespace, policyKey, policyKind } from "../../src/server/project-memory/records.js";
import { pendingConflictKind, resolvedConflictKind } from "../../src/server/project-memory/conflict-worker.js";
import { memoryFixtureOrganizer, memoryFixturePolicy } from "../support/memory-organization.js";

test("existing conflicting memory stays hidden while the configured organizer retries and resolves it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panda-memory-conflict-"));
  const metadata = new SQLiteHarnessMetadata(join(directory, "state.sqlite"));
  const owner = "owner",
    project = "atlas";
  const bucket = namespace(owner, project);
  let now = Date.now(),
    attempts = 0;
  const pages: number[] = [];
  const history = new JsonlHarnessHistory(directory, () => now);
  const service = (resolveConflict = false) =>
    new ProjectMemory(
      metadata,
      history,
      async () => {},
      undefined,
      () => now,
      undefined,
      {
        ...memoryFixtureOrganizer,
        ...(resolveConflict
          ? {
              async resolveConflict(actualOwner, selection, { key, variants }) {
                expect(actualOwner).toBe(owner);
                expect(selection).toEqual(memoryFixturePolicy.selection);
                expect(key).toBe("cache-ttl");
                attempts++;
                if (attempts === 1) return null;
                if (attempts === 2) return { selected: variants.find(({ value }) => value === "48 hours")!.id };
                pages.push(variants.length);
                return { merged: "Longstanding cache preferences", sources: variants.map(({ id }) => id) };
              },
            }
          : {}),
      },
      undefined,
      undefined,
      async () => ({ projectId: project, checkpoint: null }),
    );
  const original = service();
  const updated = service(true);
  const waitFor = async (condition: () => Promise<boolean>) => {
    for (let count = 0; count < 260; count++) {
      if (await condition()) return;
      await Bun.sleep(20);
    }
    throw new Error("Expected background conflict state was not reached");
  };

  try {
    // Older policy rows did not contain the owner and project coordinates.
    await metadata.transaction(async (tx) => {
      await save(tx, policyKey(owner, project), policyKind, bucket, {
        revision: 1,
        write: true,
        recall: true,
        organization: true,
        model: memoryFixturePolicy,
      });
      await save(tx, "conversation:atlas-existing", "conversation", owner, {
        id: "atlas-existing",
        projectId: project,
        owner,
        cwd: directory,
        historyBytes: 0,
        lastSeq: 0,
      });
    });
    const claims = async (id: string, value: string) =>
      original.saveLegacy(owner, project, { id, cwd: directory }, [{ key: "cache-ttl", scope: "project", value }]);
    await claims("historical-a", "24 hours");
    await claims("historical-b", "48 hours");
    expect((await original.catalog(owner, project))[0]?.state).toBe("conflict");
    expect(await original.find(owner, project, "")).toEqual([]);
    await original.close();

    updated.start();
    await waitFor(async () => !!(await metadata.list(pendingConflictKind, bucket)).length);
    updated.wake();
    await waitFor(async () => {
      const [job] = await metadata.list(pendingConflictKind, bucket);
      return !!job && JSON.parse(job.data).attempts === 1;
    });
    expect(attempts).toBe(1);
    expect((await updated.terrain(owner, project)).places).toEqual([]);
    expect(await updated.find(owner, project, "")).toEqual([]);
    now += 60_001;
    updated.wake();
    await waitFor(async () => !!(await metadata.list(resolvedConflictKind, bucket)).length);
    expect(attempts).toBe(2);
    const entries = await updated.find(owner, project, "");
    expect(entries.map(({ value }) => value)).toEqual(["48 hours"]);
    const detail = await updated.detail(owner, project, entries[0]!.id);
    expect(detail.versions.some(({ reason }) => reason === "conflict")).toBe(false);
    expect(await metadata.list(evidenceKind, bucket)).toHaveLength(2);
    for (let index = 0; index < 18; index++)
      await updated.saveLegacy(owner, project, { id: "additional-" + index, cwd: directory }, [
        { key: "cache-ttl", scope: "project", value: "Configuration option " + index },
      ]);
    updated.wake();
    await waitFor(async () => {
      const [entry] = await updated.find(owner, project, "");
      const job = await metadata.list(pendingConflictKind, bucket);
      return entry?.value === "Longstanding cache preferences" && !job.length;
    });
    expect(pages).toEqual([13, 7]);
    expect(await metadata.list(evidenceKind, bucket)).toHaveLength(20);
  } finally {
    await updated.close();
    await original.close();
    await metadata.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
