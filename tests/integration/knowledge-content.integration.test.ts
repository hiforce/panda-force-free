import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { stableJson } from "../../src/shared/stable-json.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { knowledgeValueDigest } from "../../src/server/knowledge/identity.js";
import { previousState, previousRequiresReview } from "../../src/server/knowledge/tasks/previous.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import type { KnowledgeTaskInput, KnowledgeRecord } from "../../src/shared/knowledge/tasks.js";

const owner = "operator:test-user";
async function fixture() {
  const files = await projectFileApiFixture();
  const created = await files.application().navigation.createFromSource(
    owner,
    {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      title: "Durable storage",
      locale: "en",
    },
    {
      identity: "isolated-knowledge-source",
      prepare: async () => ({
        body: richDocumentFromMarkdown("## Durability\n\nFlush acknowledged writes to stable storage."),
        images: [],
      }),
    },
  );
  const projects = new DocumentFileProjects(files.root, async (id) => {
    if (!files.grants.has(id)) throw new DocumentError("notFound", 404);
  });
  const content = new FileDocumentKnowledgeContent(projects),
    selection = { project: "project-1", ids: [created.operation.documentId] };
  async function capture() {
    const captured = await content.capture(owner, selection);
    const input: KnowledgeTaskInput = {
      schema: 1,
      scope: selection,
      purpose: "Durability guide",
      sources: captured.sources,
      sourceCommit: captured.commit,
      profile: { id: "default", engineId: "codex", model: "test", activeTimeoutMs: 180000 },
      target: {
        ...captured.target,
        ...(captured.previous
          ? {
              previous: {
                digest: knowledgeValueDigest(captured.previous),
                state: previousState(captured.previous),
                reviewRequired: previousRequiresReview(captured.previous),
              },
            }
          : {}),
      },
    };
    return input;
  }
  function record(input: KnowledgeTaskInput): KnowledgeRecord {
    const source = input.sources[0]!;
    const record: KnowledgeRecord = {
      schema: 1,
      id: input.target.id,
      version: "",
      previousVersion: input.target.expectedVersion,
      taskId: randomUUID(),
      sourceCommit: input.sourceCommit,
      sources: input.sources.map(({ text: _text, sections: _sections, ...metadata }) => metadata),
      draft: validateKnowledgeEvidence(
        {
          schema: 1,
          title: "Storage knowledge",
          summary: "Durability.",
          claims: [
            {
              id: "c1",
              kind: "source",
              text: "Acknowledged writes need durable storage.",
              evidence: [{ sourceId: source.id, version: source.version, quote: "stable storage" }],
            },
          ],
          uncertainties: [],
        },
        input.sources,
      ),
      approvedAt: 1000,
    };
    record.version = knowledgeRecordVersion(record);
    return record;
  }
  return { ...files, content, selection, capture, record };
}

test("approved knowledge saves readable and structured files in one Git commit without changing its original", async () => {
  const f = await fixture();
  try {
    const input = await f.capture(),
      record = f.record(input),
      before = await f.snapshots.head(),
      original = await f.application().queries.detail("project-1", f.selection.ids[0]!);
    const receipt = await f.content.save(owner, input, record);
    expect(await f.snapshots.parent(receipt.commit)).toBe(before);
    expect(await f.application().queries.detail("project-1", f.selection.ids[0]!)).toEqual(original);
    const json = await readFile(join(f.owned.directory, "knowledge", receipt.id + ".panda.json"), "utf8"),
      markdown = await readFile(join(f.owned.directory, "knowledge", receipt.id + ".md"), "utf8");
    expect(JSON.parse(json)).toEqual(record);
    expect(markdown).toContain("# Storage knowledge");
    expect(markdown).toContain("stable storage");
    expect(markdown).toContain(receipt.version);
    expect(
      (await f.snapshots.entries(receipt.commit)).filter((entry) => entry.path.startsWith("knowledge/")).length,
    ).toBe(2);
    expect(await f.content.save(owner, input, record)).toEqual(receipt);
  } finally {
    await f.close();
  }
}, 30000);

test("a late result cannot overwrite a reviewed knowledge version; replay returns its historical receipt", async () => {
  const f = await fixture();
  try {
    const original = await f.capture(),
      first = f.record(original),
      firstReceipt = await f.content.save(owner, original, first),
      newer = await f.capture(),
      second = f.record(newer);
    second.draft.summary = "A manually reviewed newer summary.";
    second.version = knowledgeRecordVersion(second);
    const latest = await f.content.save(owner, newer, second);
    expect(await f.content.save(owner, original, first)).toEqual(firstReceipt);
    expect(await f.snapshots.head()).toBe(latest.commit);
    await expect(f.content.save(owner, original, f.record(original))).rejects.toMatchObject({ code: "conflict" });
    const saved = JSON.parse(await readFile(join(f.owned.directory, "knowledge", latest.id + ".panda.json"), "utf8"));
    expect(saved.draft.summary).toBe(second.draft.summary);
  } finally {
    await f.close();
  }
}, 30000);

test("deleted sources and revoked project access cannot produce or expose a new knowledge result", async () => {
  const f = await fixture();
  try {
    const input = await f.capture(),
      record = f.record(input),
      tree = await f.application().navigation.tree("project-1");
    await f.application().navigation.trash(owner, {
      id: randomUUID(),
      projectId: "project-1",
      documentId: input.scope.ids[0],
      revision: tree.nodes[0]!.document.revision,
      treeVersion: tree.version,
    });
    expect(await f.content.current(owner, input)).toBeFalse();
    await expect(f.content.save(owner, input, record)).rejects.toMatchObject({ code: "notFound" });
    f.grants.clear();
    await expect(f.content.capture(owner, f.selection)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 30000);

test("approval binds complete captured source objects without rejecting unrelated project commits", async () => {
  const f = await fixture();
  try {
    const captured = await f.capture(),
      tree = await f.application().navigation.tree("project-1");
    await f.application().navigation.createFromSource(
      owner,
      {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: tree.version,
        parentId: null,
        title: "Unrelated",
        locale: "en",
      },
      {
        identity: randomUUID(),
        prepare: async () => ({ body: richDocumentFromMarkdown("Unrelated content"), images: [] }),
      },
    );
    expect(await f.content.current(owner, captured)).toBeTrue();
    await f.content.save(owner, captured, f.record(captured));
    const input = await f.capture(),
      before = await f.application().queries.detail("project-1", input.scope.ids[0]!),
      path = projectDocumentFile(input.scope.ids[0]!),
      envelope = JSON.parse(await readFile(join(f.owned.directory, path), "utf8"));
    envelope.document.updatedAt++;
    await f.project.coordinator.mutate({
      operationId: randomUUID(),
      author: { name: "Isolated fixture", email: "fixture@example.test" },
      message: "Update saved document metadata",
      changes: [{ path, content: stableJson(envelope) + "\n" }],
    });
    const updated = await f.application().queries.detail("project-1", input.scope.ids[0]!),
      head = await f.snapshots.head();
    expect(updated.revision.id).toBe(before.revision.id);
    expect(await f.content.current(owner, input)).toBeFalse();
    await expect(f.content.save(owner, input, f.record(input))).rejects.toMatchObject({
      code: "conflict",
      reason: "sourceChanged",
    });
    expect(await f.snapshots.head()).toBe(head);
  } finally {
    await f.close();
  }
}, 30000);
