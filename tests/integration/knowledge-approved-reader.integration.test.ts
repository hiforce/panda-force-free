import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileApprovedKnowledgeReader } from "../../src/server/knowledge/integration/approved-reader.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import { knowledgeMarkdown } from "../../src/server/knowledge/integration/markdown.js";
import { stableJson } from "../../src/shared/stable-json.js";
import { projectKnowledgeFile, projectKnowledgeMarkdown } from "../../src/server/project-content/paths.js";
import { currentDraftContent } from "../../src/server/project-content/drafts/content.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { knowledgeCatalogFixture } from "../support/knowledge-catalog-fixture.js";
import type { KnowledgeAdmission } from "../../src/shared/knowledge/catalog.js";
function reader(f: Awaited<ReturnType<typeof knowledgeCatalogFixture>>) {
  return new FileApprovedKnowledgeReader(
    f.catalog,
    async () => f.documents.application().projectContent,
    () => {},
  );
}

test("approved multi-source reading requires workflow admission and ignores a self-hashed file pair", async () => {
  const f = await knowledgeCatalogFixture(),
    approved = reader(f),
    scope = { owner: f.owner, project: f.admission.project };
  try {
    expect((await approved.snapshot(scope)).records).toEqual([]);
    f.complete();
    const before = await approved.head(scope),
      values = await approved.current(scope, [f.record.id]);
    expect(values).toHaveLength(1);
    expect(values[0]!.sources).toHaveLength(2);
    expect(values[0]!.record).toEqual(f.record);
    const forged = { ...f.record, id: "k-forged", taskId: "not-approved", version: "" };
    forged.version = knowledgeRecordVersion(forged);
    await f.documents.project.coordinator.mutate({
      operationId: randomUUID(),
      author: { name: "Isolated fixture", email: "fixture@example.test" },
      message: "Add isolated unadmitted content",
      changes: [
        { path: projectKnowledgeFile(forged.id), content: stableJson(forged) + "\n" },
        { path: projectKnowledgeMarkdown(forged.id), content: knowledgeMarkdown(forged) },
      ],
    });
    expect(await approved.head(scope)).toBe(before);
    expect((await approved.snapshot(scope)).records.map((value) => value.record.id)).toEqual([f.record.id]);
    expect(await approved.current(scope, [forged.id])).toEqual([]);
    f.documents.grants.clear();
    await expect(approved.snapshot(scope)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 20000);
test("one selected approved result bypasses a large unrelated catalog and reads each output only once", async () => {
  const f = await knowledgeCatalogFixture();
  try {
    f.complete();
    const row = f.db
        .query<Record<string, string | number | null>, [string]>("SELECT * FROM knowledge_tasks WHERE id=?")
        .get(f.admission.taskId)!,
      columns = Object.keys(row),
      insert = f.db.query(
        "INSERT INTO knowledge_tasks(" + columns.join(",") + ") VALUES(" + columns.map(() => "?").join(",") + ")",
      );
    f.db
      .transaction(() => {
        for (let i = 0; i < 10005; i++) {
          const copy: Record<string, string | number | null> = {
            ...row,
            id: "unrelated-" + i,
            result: JSON.stringify({ ...f.admission.receipt, id: "unrelated-" + i }),
          };
          insert.run(...columns.map((k) => copy[k]!));
        }
      })
      .immediate();
    expect(() => f.catalog.list(f.owner, f.admission.project)).toThrow("budget");
    const files = new Map<string, number>(),
      projects = f.documents.application().projectContent;
    const approved = new FileApprovedKnowledgeReader(
      f.catalog,
      async () => ({
        authorize: (id) => projects.authorize(id),
        ifPresent: (id, work) =>
          projects.ifPresent(id, (project, view) =>
            work(
              project,
              new Proxy(view, {
                get(target, key) {
                  if (key === "read")
                    return async (path: string) => {
                      files.set(path, (files.get(path) ?? 0) + 1);
                      return target.read(path);
                    };
                  const value = Reflect.get(target, key);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              }),
            ),
          ),
      }),
      () => {},
    );
    f.catalog.list = () => {
      throw Error("Selected hydration traversed the complete catalog");
    };
    const before = await f.documents.snapshots.head();
    const values = await approved.current({ owner: "project-member", project: f.admission.project }, [
      f.record.id,
      f.record.id,
    ]);
    expect(values.map((v) => v.record)).toEqual([f.record]);
    expect(files.get(projectKnowledgeFile(f.record.id))).toBe(1);
    expect(files.get(projectKnowledgeMarkdown(f.record.id))).toBe(1);
    expect(await f.documents.snapshots.head()).toBe(before);
  } finally {
    await f.close();
  }
}, 20000);
test("selected reads repair only their missing admission projection without granting approval", async () => {
  const f = await knowledgeCatalogFixture(),
    repairs: KnowledgeAdmission[][] = [];
  try {
    f.complete();
    const task = f.ledger.get(f.owner, f.admission.taskId),
      head = await f.documents.snapshots.head();
    f.db.exec("DELETE FROM knowledge_catalog");
    const approved = new FileApprovedKnowledgeReader(
      f.catalog,
      async () => f.documents.application().projectContent,
      (missing) => repairs.push([...missing]),
    );
    await expect(
      approved.current({ owner: f.owner, project: f.admission.project }, [f.record.id]),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(repairs).toEqual([[f.admission]]);
    expect(f.ledger.get(f.owner, f.admission.taskId)).toEqual(task);
    expect(await f.documents.snapshots.head()).toBe(head);
    expect(f.catalog.save(f.admission, f.projection)).toBeTrue();
    expect(
      (await approved.current({ owner: f.owner, project: f.admission.project }, [f.record.id]))[0]!.record,
    ).toEqual(f.record);
  } finally {
    await f.close();
  }
}, 20000);
test("changing any one of multiple original versions removes old knowledge immediately", async () => {
  const f = await knowledgeCatalogFixture(),
    approved = reader(f),
    scope = { owner: f.owner, project: f.admission.project };
  try {
    f.complete();
    const before = await approved.head(scope),
      id = f.projection.sources[1]!.id,
      detail = await f.documents.application().queries.detail(scope.project, id);
    await f.documents.application().changes.apply(f.owner, scope.project, id, {
      operationId: randomUUID(),
      expectedRevisionId: detail.revision.id,
      expectedVersion: detail.revision.number,
      expectedContentHash: detail.revision.contentHash,
      intentHash: "a".repeat(64),
      content: {
        ...currentDraftContent(detail),
        content: "Changed authoritative source.",
        body: richDocumentFromMarkdown("Changed authoritative source."),
      },
    });
    expect(await approved.head(scope)).not.toBe(before);
    expect(await approved.current(scope, [f.record.id])).toEqual([]);
    expect(f.catalog.current(f.admission)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 20000);
test("moving an original changes the eligibility head while preserving approved content identity", async () => {
  const f = await knowledgeCatalogFixture(),
    approved = reader(f),
    scope = { owner: f.owner, project: f.admission.project };
  try {
    f.complete();
    const before = await approved.head(scope),
      [child, parent] = f.input.scope.ids,
      tree = await f.documents.application().navigation.tree(scope.project);
    await f.documents.application().navigation.move(f.owner, {
      id: randomUUID(),
      projectId: scope.project,
      treeVersion: tree.version,
      documentId: child,
      target: { kind: "inside", documentId: parent },
    });
    expect(await approved.head(scope)).not.toBe(before);
    const value = (await approved.current(scope, [f.record.id]))[0]!;
    expect(value.record).toEqual(f.record);
    expect(value.sources.find((source) => source.id === child)!.ancestors).toEqual([parent!]);
    expect(value.sources.find((source) => source.id === parent)!.ancestors).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);
test("out-of-band physical corruption is never returned as approved content", async () => {
  const f = await knowledgeCatalogFixture(),
    approved = reader(f),
    scope = { owner: f.owner, project: f.admission.project };
  try {
    f.complete();
    const before = await approved.head(scope);
    await writeFile(join(f.documents.owned.directory, projectKnowledgeFile(f.record.id)), "{}");
    expect(await approved.head(scope)).toBe(before);
    await expect(approved.current(scope, [f.record.id])).rejects.toMatchObject({ code: "conflict" });
    expect(f.ledger.get(f.owner, f.admission.taskId).state).toBe("completed");
  } finally {
    await f.close();
  }
}, 20000);
test("an authorized empty project has an empty knowledge head without initializing content", async () => {
  const f = await knowledgeCatalogFixture(),
    approved = reader(f),
    scope = { owner: f.owner, project: "empty-project" };
  try {
    f.documents.grants.add(scope.project);
    const head = await approved.head(scope);
    expect(await approved.snapshot(scope)).toEqual({ commit: head, records: [] });
    expect(await approved.current(scope, [f.record.id])).toEqual([]);
    expect(await f.documents.application().projectContent.ifPresent(scope.project, async () => true)).toBeNull();
    f.documents.grants.delete(scope.project);
    await expect(approved.head(scope)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 20000);
