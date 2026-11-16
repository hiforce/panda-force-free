import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalContent } from "../../src/server/creative/personal.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { routeKnowledgeContent } from "../../src/server/knowledge/integration/content-router.js";
import { recoverKnowledgeOutput } from "../../src/server/knowledge/integration/output-recovery.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { projectKnowledgeFile } from "../../src/server/project-content/paths.js";
import type { KnowledgeRecord, KnowledgeTaskInput } from "../../src/shared/knowledge/tasks.js";

test("personal identity rotation allows only exact committed receipt recovery, without a new writer or a late mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-personal-receipt-"));
  let principal = "alice",
    starts = 0;
  const authorize = (owner: string) => {
    if (owner !== principal) throw new DocumentError("notFound", 404);
  };
  const personal = new PersonalContent({
    contentRoot: join(root, "content"),
    assetRoot: join(root, "assets"),
    stateRoot: join(root, "state"),
    owner: () => principal,
    authorize,
    creation: () => ({
      routes: [],
      start() {
        starts++;
      },
      close: async () => {},
    }),
  });
  try {
    const writer = await personal.forOwner("alice"),
      content = new FileDocumentKnowledgeContent(writer.documents.projectContent);
    const doc = await writer.documents.navigation.createFromSource(
      "alice",
      {
        id: randomUUID(),
        projectId: "personal",
        treeVersion: 0,
        parentId: null,
        title: "Private storage",
        locale: "en",
      },
      {
        identity: randomUUID(),
        prepare: async () => ({ body: richDocumentFromMarkdown("Private durable storage."), images: [] }),
      },
    );
    const scope = { project: "personal", ids: [doc.operation.documentId] },
      captured = await content.capture("alice", scope);
    const input: KnowledgeTaskInput = {
      schema: 1,
      scope,
      purpose: "Explain private storage",
      sources: captured.sources,
      sourceCommit: captured.commit,
      target: captured.target,
      profile: { id: "test", engineId: "codex", model: "fixture", activeTimeoutMs: 180000 },
    };
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
          title: "Private knowledge",
          summary: "A private saved fact.",
          claims: [
            {
              id: "claim1",
              kind: "source",
              text: "Durable storage is required.",
              evidence: [{ sourceId: source.id, version: source.version, quote: "durable" }],
            },
          ],
          uncertainties: [],
        },
        input.sources,
      ),
      approvedAt: 1000,
      approval: { mode: "manual" },
    };
    record.version = knowledgeRecordVersion(record);
    const receipt = await content.save("alice", input, record),
      projection = await content.projection("alice", input, record, receipt);
    const routed = routeKnowledgeContent(
      async () => {
        throw Error("No project adapter selected");
      },
      async (owner) => {
        authorize(owner);
        return new FileDocumentKnowledgeContent((await personal.forOwner(owner)).documents.projectContent);
      },
      async (owner) => authorize(owner),
      (owner, input, record, missing) =>
        recoverKnowledgeOutput(personal.readProjects(owner), owner, input, record, missing),
    );
    const head = () => personal.readProjects("alice").ifPresent("personal", async (_project, view) => view.commit);
    const before = await head();
    await expect(
      writer.documents.projectContent.write("personal", (project) =>
        project.coordinator.plan(
          {
            operationId: randomUUID(),
            author: { name: "Alice", email: "alice@example.invalid" },
            message: "Write prepared personal content",
            intent: "prepared-personal-command",
          },
          async () => {
            principal = "bob";
            return { changes: [{ path: projectKnowledgeFile("k-late"), content: "{}\n" }] };
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await head()).toBe(before);
    await expect(personal.forOwner("alice")).rejects.toMatchObject({ status: 404 });
    await expect(routed.capture("alice", scope)).rejects.toMatchObject({ status: 404 });
    await expect(routed.save("alice", input, record)).rejects.toMatchObject({ status: 404 });
    expect(await routed.recover?.("alice", input, record)).toEqual({ receipt, projection });
    expect(await routed.recover?.("bob", input, record)).toBeNull();
    const unwrittenInput = { ...input, target: { id: "k-unwritten", expectedVersion: null } },
      unwritten: KnowledgeRecord = { ...record, id: "k-unwritten", taskId: randomUUID(), version: "" };
    unwritten.version = knowledgeRecordVersion(unwritten);
    let missing = false;
    expect(
      await routed.recover?.("alice", unwrittenInput, unwritten, async () => {
        missing = true;
      }),
    ).toBeNull();
    expect(missing).toBeTrue();
    expect(await head()).toBe(before);
    expect(starts).toBe(1);
    expect(await readdir(join(root, "content", "personal"))).toEqual([
      createHash("sha256").update("alice").digest("hex"),
    ]);
  } finally {
    await personal.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
