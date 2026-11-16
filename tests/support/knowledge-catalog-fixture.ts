import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFileApiFixture } from "./project-file-api-fixture.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { KnowledgeCatalogStore } from "../../src/server/knowledge/storage/catalog.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import type { KnowledgeRecord, KnowledgeTaskInput } from "../../src/shared/knowledge/tasks.js";
import type { KnowledgeDraftInput } from "../../src/shared/knowledge/contracts.js";
import type { Route } from "../../src/server/http/router.js";

export async function knowledgeCatalogFixture(routes?: Route[]) {
  const documents = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-approved-catalog-")),
    db = openKnowledgeDatabase(join(root, "data", "knowledge.sqlite")),
    ledger = knowledgeTaskLedger(db),
    catalog = new KnowledgeCatalogStore(db),
    files = knowledgeTaskFiles(join(root, "knowledge", "tasks")),
    content = new FileDocumentKnowledgeContent(documents.application().projectContent),
    owner = "alice",
    ids: string[] = [];
  try {
    for (const [title, text] of [
      ["Storage", "A durable indexed source."],
      ["Constraints", "A second source contains current constraints."],
    ]) {
      const tree = await documents.application().navigation.tree("project-1");
      const created = await documents.application().navigation.createFromSource(
        owner,
        {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: tree.version,
          parentId: null,
          title: title!,
          locale: "en",
        },
        { identity: randomUUID(), prepare: async () => ({ body: richDocumentFromMarkdown(text!), images: [] }) },
      );
      ids.push(created.operation.documentId);
    }
    const scope = { project: "project-1", ids: [...ids].sort() },
      captured = await content.capture(owner, scope),
      input: KnowledgeTaskInput = {
        schema: 1,
        scope,
        purpose: "Describe both saved sources",
        sources: captured.sources,
        sourceCommit: captured.commit,
        target: captured.target,
        profile: { id: "test", engineId: "codex", model: "synthetic", activeTimeoutMs: 180000 },
      },
      inputDigest = await files.putInput(input),
      dialogueDigest = await files.putDialogue({ questions: [], answers: [] }),
      task = ledger.create(
        {
          owner,
          project: scope.project,
          title: "Reviewed pair",
          operationId: randomUUID(),
          requestHash: "r".repeat(64),
          signature: "s".repeat(64),
          inputDigest,
          dialogueDigest,
        },
        1000,
      ),
      lease = ledger.claim(1001, 10000)!,
      execution = ledger.bind(lease.lease, { sessionId: "isolated-session", runId: "isolated-run" }, 1001),
      draft: KnowledgeDraftInput = {
        schema: 1,
        title: "Reviewed source pair",
        summary: "A summary of two independently versioned originals.",
        claims: [
          {
            id: "claim1",
            kind: "source",
            text: "Durable storage is required.",
            evidence: [
              {
                sourceId: input.sources.find((source) => source.text.includes("durable"))!.id,
                version: input.sources.find((source) => source.text.includes("durable"))!.version,
                quote: "durable",
              },
            ],
          },
          {
            id: "claim2",
            kind: "source",
            text: "Current constraints apply.",
            evidence: [
              {
                sourceId: input.sources.find((source) => source.text.includes("constraints"))!.id,
                version: input.sources.find((source) => source.text.includes("constraints"))!.version,
                quote: "constraints",
              },
            ],
          },
        ],
        uncertainties: [],
      },
      record: KnowledgeRecord = {
        schema: 1,
        id: input.target.id,
        version: "",
        previousVersion: input.target.expectedVersion,
        taskId: task.id,
        sourceCommit: input.sourceCommit,
        sources: input.sources.map(({ text: _text, sections: _sections, ...metadata }) => metadata),
        draft: validateKnowledgeEvidence(draft, input.sources),
        approvedAt: 1003,
        approval: { mode: "manual" },
      };
    record.version = knowledgeRecordVersion(record);
    ledger.draft(execution, await files.putDraft(draft), 1002);
    const outputDigest = await files.putOutput(record);
    ledger.admit(owner, task.id, 1, outputDigest, 1004);
    const receipt = await content.save(owner, input, record),
      projection = await content.projection(owner, input, record, receipt),
      admission = { owner, project: scope.project, taskId: task.id, outputDigest, inputDigest, receipt };
    return {
      documents,
      root,
      db,
      ledger,
      catalog,
      files,
      content,
      owner,
      input,
      record,
      admission,
      projection,
      complete: () => ledger.complete(owner, task.id, outputDigest, receipt, 1005, projection),
      close: async () => {
        db.close();
        await documents.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db.close();
    await documents.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
