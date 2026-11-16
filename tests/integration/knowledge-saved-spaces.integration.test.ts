import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { projectSpaceFixture } from "../support/project-space-fixture.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { fileKnowledgeGenerationSource } from "../../src/server/knowledge/integration/generation-content.js";
import { savedKnowledgeDocuments } from "../../src/server/knowledge/integration/saved-documents.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import {
  encodeProjectNavigation,
  type ProjectNavigationState,
} from "../../src/server/project-content/navigation-file.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";

const author = { name: "Saved source fixture", email: "sources@example.test" },
  scope = { owner: "alice", project: "project-1" };

async function fixture() {
  const documents = await projectFileApiFixture(),
    root = await mkdtemp(join(tmpdir(), "panda-knowledge-spaces-"));
  await documents.project.spaces.put(projectSpaceFixture("site-1"), null, "publication", randomUUID(), author);
  for (const id of ["site-parent", "site-child"]) {
    const detail = projectDocumentFixture(1, id, `# ${id}\n\nSaved publication decisions for ${id}.`);
    detail.document.spaceId = "site-1";
    await documents.project.documents.put(detail, null, randomUUID(), author);
  }
  const feature = createKnowledgeFeature({
      stateRoot: root,
      content: new FileDocumentKnowledgeContent(documents.application().projectContent),
      documents: async () => documents.application().projectContent,
      owner: () => scope.owner,
      available: () => true,
      report(error) {
        throw error;
      },
      profile: async () => ({ id: "test", engineId: "codex", model: "synthetic", activeTimeoutMs: 1000 }),
      engine() {
        throw Error("This fixture never requests inference");
      },
    }),
    db = openKnowledgeDatabase(join(root, "data", "knowledge.sqlite")),
    ledger = knowledgeTaskLedger(db),
    files = knowledgeTaskFiles(join(root, "knowledge", "tasks")),
    source = fileKnowledgeGenerationSource(async () => documents.application().projectContent);
  return {
    documents,
    feature,
    source,
    async navigation(states: ProjectNavigationState[]) {
      return documents.application().projectContent.write(scope.project, (project) =>
        project.coordinator.plan(
          { operationId: randomUUID(), author, message: "Update saved source navigation", intent: randomUUID() },
          async () => ({
            changes: [
              {
                path: "tree.json",
                content: encodeProjectNavigation({ schema: 1, projectId: scope.project, spaces: states }),
              },
            ],
          }),
        ),
      );
    },
    async review(ids: string[]) {
      const task = await feature.service.submit(scope.owner, {
          id: randomUUID(),
          project: scope.project,
          ids,
          purpose: "Explain the saved decisions.",
        }),
        row = ledger.get(scope.owner, task.id),
        input = await files.input(row.inputDigest),
        draftDigest = await files.putDraft({
          schema: 1,
          title: "Saved decisions",
          summary: "Decisions from owned saved sources.",
          claims: input.sources.map((source, index) => ({
            id: "claim-" + index,
            kind: "source",
            text: "Saved decision from " + source.title,
            evidence: [{ sourceId: source.id, version: source.version, quote: source.text.slice(0, 80) }],
          })),
          uncertainties: [],
        }),
        claim = ledger.claim(Date.now(), 30000)!;
      expect(claim.task.id).toBe(task.id);
      const execution = ledger.bind(claim.lease, { sessionId: "isolated-session", runId: "isolated-run" }, Date.now());
      ledger.draft(execution, draftDigest, Date.now());
      const detail = await feature.service.detail(scope.owner, task.id),
        completed = await feature.service.approve(scope.owner, task.id, { revision: detail.task.reviewRevision });
      expect(completed.state).toBe("completed");
      return { input, completed };
    },
    async close() {
      await feature.close();
      db.close();
      await documents.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const state = (spaceId: string): ProjectNavigationState => ({
  spaceId,
  version: 1,
  nodes: [],
  trash: [],
  origins: [],
  lastOperation: null,
});

test("saved originals outside the library enter real review, Git delivery and approved reads without publication copies", async () => {
  const f = await fixture();
  try {
    const before = await f.documents.snapshots.head(),
      snapshot = await f.source.snapshot(scope.owner, scope.project);
    expect(new Set(snapshot.documents.map((item) => item.id))).toEqual(new Set(["doc-1", "site-parent", "site-child"]));
    expect(await f.documents.snapshots.head()).toBe(before);
    await f.documents.application().editor.autosave(scope.owner, scope.project, "site-child", {
      operationId: randomUUID(),
      version: 0,
      baseRevisionId: "site-child-rev-1",
      working: { title: "Unsaved", locale: "en", content: "This working draft must stay private.", resources: [] },
    });
    const reviewed = await f.review(["doc-1", "site-child"]),
      records = (await f.feature.approved.snapshot(scope)).records;
    expect(records).toHaveLength(1);
    expect(records[0]!.record.id).toBe(reviewed.completed.result!.id);
    expect(records[0]!.sources.map((source) => source.id)).toEqual(["doc-1", "site-child"]);
    expect(reviewed.input.sources.find((source) => source.id === "site-child")!.text).toContain(
      "Saved publication decisions",
    );
    expect(JSON.stringify(records)).not.toContain("This working draft must stay private");
    f.documents.reopen();
    expect((await f.feature.approved.snapshot(scope)).records).toEqual(records);
    const next = projectDocumentFixture(2, "site-child", "A new saved publication decision.");
    next.document.spaceId = "site-1";
    await f.documents.project.documents.put(next, 1, randomUUID(), author);
    expect((await f.feature.approved.snapshot(scope)).records).toEqual([]);
    f.documents.grants.clear();
    await expect(f.source.snapshot(scope.owner, scope.project)).rejects.toMatchObject({ code: "notFound" });
    await expect(f.feature.approved.snapshot(scope)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 30000);

test("subtrees in publication spaces retain their ancestry and trash immediately withdraws approved knowledge", async () => {
  const f = await fixture();
  try {
    const publication = state("site-1");
    publication.nodes = [
      { documentId: "site-parent", parentId: null, position: 0 },
      { documentId: "site-child", parentId: "site-parent", position: 0 },
    ];
    await f.navigation([publication]);
    const snapshot = await f.source.snapshot(scope.owner, scope.project);
    expect(snapshot.documents.find((document) => document.id === "site-child")!.parentId).toBe("site-parent");
    const policy = defaultGenerationPolicy();
    policy.enabled = true;
    policy.purpose = "Explain saved publication decisions.";
    policy.selection.subtrees = ["site-parent"];
    const preview = await f.feature.generationSettings!.preview(scope.owner, scope.project, {
      ...policy,
      backfill: false,
    });
    expect(preview.count).toBe(2);
    expect(new Set(preview.documents)).toEqual(new Set(["site-parent", "site-child"]));
    policy.selection.excludeDocuments = ["site-child"];
    expect(
      (await f.feature.generationSettings!.preview(scope.owner, scope.project, { ...policy, backfill: false }))
        .documents,
    ).toEqual(["site-parent"]);
    await f.review(["site-child"]);
    const record = (await f.feature.approved.snapshot(scope)).records[0]!;
    expect(record.sources[0]!.ancestors).toEqual(["site-parent"]);
    publication.nodes = publication.nodes.filter((node) => node.documentId !== "site-child");
    publication.trash = [
      { documentId: "site-child", parentId: null, position: null, operationId: null, deletedAt: Date.now() },
    ];
    publication.version++;
    await f.navigation([publication]);
    expect(
      (await f.source.snapshot(scope.owner, scope.project)).documents.some((document) => document.id === "site-child"),
    ).toBe(false);
    expect((await f.feature.approved.snapshot(scope)).records).toEqual([]);
    await expect(
      f.feature.service.submit(scope.owner, { id: randomUUID(), project: scope.project, ids: ["site-child"] }),
    ).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 30000);

test("requested sources inspect only relevant imported headers and reject navigation with the wrong owned space", async () => {
  const f = await fixture();
  try {
    await f.documents.application().projectContent.view(scope.project, async (_project, view) => {
      const saved = await savedKnowledgeDocuments(
        {
          commit: view.commit,
          paths: view.paths,
          assertHeld: view.assertHeld.bind(view),
          version: view.version.bind(view),
          read: view.read.bind(view),
          inspect: async (path, read) => {
            if (path === projectDocumentFile("doc-1") || path === projectDocumentFile("site-parent"))
              throw Error("Unrelated body header inspected");
            return view.inspect(path, read);
          },
        },
        scope.project,
        new Set(["site-child"]),
      );
      expect([...saved.documents.keys()]).toEqual(["site-child"]);
      expect((await saved.read("site-child")).source.version).toBe("site-child-rev-1");
    });
    const wrong = state("space-1");
    wrong.nodes = [{ documentId: "site-child", parentId: null, position: 0 }];
    await f.navigation([wrong]);
    await f.documents.application().projectContent.view(scope.project, async (_project, view) => {
      const saved = await savedKnowledgeDocuments(view, scope.project, new Set(["site-child"]));
      await expect(saved.read("site-child")).rejects.toMatchObject({ code: "invalidFile" });
    });
    await expect(
      f.feature.service.submit(scope.owner, { id: randomUUID(), project: scope.project, ids: ["site-child"] }),
    ).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(await f.feature.service.list(scope.owner, scope.project)).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
