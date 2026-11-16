import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { legacyHistoryFixture } from "../support/legacy-history-fixture.js";
import { resourceBuildFixture } from "../support/resource-build.js";
import { ResourceBuildRequest } from "../../src/shared/builds/resources.js";
import { encodeResourceBuild } from "../../src/shared/builds/resource-frame.js";
import { LegacyProjectDocuments } from "../../src/server/project-content/migration/legacy-documents.js";
import { inventoryLegacyProjectHistory } from "../../src/server/content-migration/history/inventory.js";
import type { SiteBuildRequest } from "../../src/shared/builds/jobs.js";

async function fixture() {
  const f = await legacyHistoryFixture();
  try {
    const base = await resourceBuildFixture(),
      request: SiteBuildRequest = {
        ...JSON.parse(
          f.db.query<{ request: string }, [string]>("SELECT request FROM site_builds WHERE id=?").get(f.build.id)!
            .request,
        ),
        id: randomUUID(),
        nativeTheme: { id: base.theme.id, version: base.theme.version, digest: "e".repeat(64) },
      },
      input = await ResourceBuildRequest.create(
        {
          ...base.input,
          documents: [
            {
              id: f.f.document.document.id,
              path: "original.md",
              title: "Original",
              content: f.f.document.revision.content,
            },
          ],
        },
        base.theme,
        base.tree,
      ),
      reserved = f.builds.resources.reserve("owner", request, input, f.build.sources);
    return { f, request, input, job: reserved.value.job };
  } catch (error) {
    await f.close();
    throw error;
  }
}

for (const archived of [false, true])
  test(
    "read-only history retains native build ownership and immutable input receipts, archived=" + archived,
    async () => {
      const { f, job, request, input } = await fixture();
      try {
        if (archived) {
          f.builds.resources.accept(job.id, input.digest, encodeResourceBuild(input).length);
          f.builds.update(job.id, { phase: "completed" });
          f.builds.remove(job.id);
        }
        const before = f.db.serialize(),
          result = await f.inspect();
        expect(result.after).toEqual(result.before);
        expect(f.db.serialize()).toEqual(before);
        expect(result.result.schemas.site_build_schema).toBe(3);
        expect(
          result.result.records.filter((row) => row.table === "site_build_resource_inputs").map((row) => row.key),
        ).toEqual([job.id]);
        expect(result.result.blockers.some((row) => row.id === job.id && row.kind === "active-build")).toBe(!archived);
        expect(f.builds.existing(request, "owner")!.inputHash).toBe(input.digest);
        expect(f.f.requests).toEqual([]);
        expect(JSON.stringify(result.result)).not.toContain("owner");
      } finally {
        await f.close();
      }
    },
    30000,
  );

for (const corruption of [
  "missing-receipt",
  "unowned",
  "theme-mismatch",
  "active-tombstone",
  "missing-table",
  "future-schema",
] as const)
  test(
    "read-only history rejects " + corruption + " without altering a resource backup",
    async () => {
      const { f, job } = await fixture();
      try {
        const path = await f.editBackup((db) => {
            if (corruption === "missing-receipt")
              db.query("DELETE FROM site_build_resource_inputs WHERE id=?").run(job.id);
            if (corruption === "unowned") db.exec("UPDATE site_build_resource_inputs SET owner=''");
            if (corruption === "theme-mismatch")
              db.query("UPDATE site_builds SET request=? WHERE id=?").run(JSON.stringify({ id: job.id }), job.id);
            if (corruption === "active-tombstone") db.query("UPDATE site_builds SET removed=1 WHERE id=?").run(job.id);
            if (corruption === "missing-table") db.exec("DROP TABLE site_build_resource_inputs");
            if (corruption === "future-schema") db.exec("UPDATE site_build_schema SET version=4");
          }),
          before = await readFile(path),
          source = await LegacyProjectDocuments.open(path, f.f.space.projectId);
        try {
          expect(() => inventoryLegacyProjectHistory(source)).toThrow(
            corruption === "future-schema" ? "unsupportedSchema" : "invalidFile",
          );
        } finally {
          source.close();
        }
        expect(await readFile(path)).toEqual(before);
        expect(f.f.requests).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30000,
  );

test("schema two build history remains readable without bootstrapping resource receipts", async () => {
  const f = await legacyHistoryFixture();
  try {
    const path = await f.editBackup((db) => {
        db.exec(
          "DROP TABLE site_build_resource_inputs; ALTER TABLE site_builds DROP COLUMN removed; UPDATE site_build_schema SET version=2",
        );
      }),
      before = await readFile(path),
      source = await LegacyProjectDocuments.open(path, f.f.space.projectId);
    try {
      const result = inventoryLegacyProjectHistory(source);
      expect(result.schemas.site_build_schema).toBe(2);
      expect(result.records.filter((row) => row.table === "site_builds")).toHaveLength(1);
      expect(result.records.filter((row) => row.table === "site_build_resource_inputs")).toEqual([]);
    } finally {
      source.close();
    }
    expect(await readFile(path)).toEqual(before);
  } finally {
    await f.close();
  }
}, 30000);
