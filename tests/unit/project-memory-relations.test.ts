import { expect, test } from "bun:test";
import { memoryFocusPages } from "../../src/server/project-memory/focus-terrain.js";
import { organizationCli } from "../../src/server/project-memory/organization-tools.js";
import { describeMemory } from "../../src/server/project-memory/projection.js";
import { entryId, entryVersion, type MemoryEvidence } from "../../src/server/project-memory/records.js";
import { memoryTerrainRelations } from "../../src/server/project-memory/relations.js";

const a = entryId("release", "project");
const b = entryId("tests", "project");
const passing = "Tests are passing";
const targetVersion = entryVersion(b, passing);
const sourceId = "user-message";
const quote = "Release depends on the test result.";
const job = "a".repeat(32);

test("the organizer binds explicit relationships to a current or same-batch target and exact source", async () => {
  const context = {
    job,
    sources: [{ id: sourceId, user: quote }],
    existing: [
      {
        key: "tests",
        scope: "project",
        version: targetVersion,
        value: passing,
      },
    ],
  };
  const relation = { key: "Tests", scope: "project", kind: "dependsOn" };
  const entry = { key: "Release", scope: "project", value: "Run release", sourceId, quote, relations: [relation] };
  const submit = async (entries: unknown[], input = context) => {
    const cli = organizationCli(input);
    await cli.submit(JSON.stringify({ entries }));
    return cli.result()!;
  };
  expect(await submit([entry])).toMatchObject([
    {
      expectedRelations: [{ id: b, version: targetVersion }],
      relations: [{ target: b, targetVersion, kind: "dependsOn" }],
    },
  ]);
  const sameBatch = await submit([entry, { ...entry, key: "Tests", value: passing, relations: [] }], {
    ...context,
    existing: [],
  });
  expect(sameBatch[0]?.relations).toEqual([{ target: b, targetVersion, kind: "dependsOn" }]);
  expect(sameBatch[0]?.expectedRelations).toBeUndefined();
  await expect(submit([{ ...entry, quote: "made up" }])).rejects.toThrow();
  await expect(submit([{ ...entry, relations: [relation, relation] }])).rejects.toThrow();
  await expect(submit([{ ...entry, relations: [{ ...relation, key: "release" }] }])).rejects.toThrow();
  await expect(submit([{ ...entry, relations: [{ ...relation, key: "unknown" }] }])).rejects.toThrow();
  await expect(submit([{ ...entry, relations: [{ ...relation, kind: "unlink" }] }])).rejects.toThrow();
});

function evidence(key: string, value: string, messageId: string, fields: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    id: messageId,
    key,
    scope: "project",
    value,
    conversationId: "shared",
    messageId,
    generation: 0,
    replaces: false,
    recordedAt: 1,
    ...fields,
  } as MemoryEvidence;
}

test("terrain links have accessible current evidence and retain valid off-page destinations", () => {
  const release = evidence("release", "Run release", "one", {
    relations: [{ target: b, targetVersion, kind: "dependsOn" }],
  });
  const tests = evidence("tests", passing, "two");
  const sameSource = evidence("sign-off", "Confirmed", "one");
  const unrelated = evidence("layout", "Compact", "three");
  const projectTerrain = (rows: MemoryEvidence[][]) => {
    const groups = new Map(rows.map((items) => [entryId(items[0]!.key, items[0]!.scope), items]));
    const entries = [...groups].map(([id, group]) => describeMemory(id, group));
    return memoryTerrainRelations([{ entry: entries[0]!, slot: 0 }], entries, groups);
  };
  const active = projectTerrain([[release], [tests], [sameSource], [unrelated]]);
  expect(active.links).toMatchObject([
    { from: a, to: b, kind: "dependsOn", source: { conversationId: "shared", messageId: "one" } },
    {
      from: a,
      to: entryId("sign-off", "project"),
      kind: "sameSource",
      source: { conversationId: "shared", messageId: "one" },
    },
  ]);
  expect(active.related.map(({ key }) => key)).toEqual(["tests", "sign-off"]);
  expect(projectTerrain([[release], [tests, { ...tests, value: "Failed" }]]).links).toEqual([]);
  expect(projectTerrain([[release], [{ ...tests, value: "Failed" }]]).links).toEqual([]);
  expect(projectTerrain([[release]]).links).toEqual([]);
  expect(projectTerrain([[{ ...release, projectedFrom: "Initial release" }], [tests]]).links).toEqual([]);
  const correction = evidence("release", release.value, "four", {
    recordedAt: 2,
    relations: [{ target: b, targetVersion, kind: "unlink" }],
  });
  expect(projectTerrain([[release, correction], [tests]]).links).toEqual([]);
  expect(projectTerrain([[release], [tests]]).links).toHaveLength(1);
});

test("two-hop focus pages retain the real intermediate entry and omit unrelated or withdrawn entries", () => {
  const release = evidence("release", "Run release", "release-only", {
    relations: [{ target: b, targetVersion, kind: "dependsOn" }],
  });
  const tests = evidence("tests", passing, "test-report");
  const second = Array.from({ length: 7 }, (_, i) => evidence("result-" + i, "Recorded", "test-report"));
  const unrelated = evidence("unrelated", "No overlap", "unrelated-message");
  const rows = [release, tests, ...second, unrelated];
  const groups = new Map(rows.map((row) => [entryId(row.key, row.scope), [row]]));
  const entries = [...groups].map(([id, evidence]) => describeMemory(id, evidence));
  const root = entries[0]!;
  const one = memoryFocusPages(root, entries, groups, 1);
  expect(one.map((page) => page.map(({ depth }) => depth))).toEqual([[0, 1]]);
  const two = memoryFocusPages(root, entries, groups, 2);
  expect(two).toHaveLength(2);
  expect(two.every((page) => page[0]!.entry.id === a && page[1]!.entry.id === b && page.length <= 6)).toBe(true);
  expect(two.flatMap((page) => page.filter(({ depth }) => depth === 2).map(({ entry }) => entry.key)).sort()).toEqual(
    second.map(({ key }) => key).sort(),
  );
  expect(
    memoryFocusPages(
      root,
      entries.filter(({ id }) => id !== b),
      groups,
      2,
    ),
  ).toHaveLength(1);
});
