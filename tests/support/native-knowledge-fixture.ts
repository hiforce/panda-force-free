import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFileApiFixture } from "./project-file-api-fixture.js";
import { officeFixture } from "./office-presentation.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { FileApprovedKnowledgeReader } from "../../src/server/knowledge/integration/approved-reader.js";
import { openKnowledgeDatabase } from "../../src/server/knowledge/storage/database.js";
import { knowledgeTaskLedger } from "../../src/server/knowledge/storage/ledger.js";
import { KnowledgeCatalogStore } from "../../src/server/knowledge/storage/catalog.js";
import { knowledgeTaskFiles } from "../../src/server/knowledge/integration/task-files.js";
import { knowledgeRecordVersion } from "../../src/server/knowledge/tasks/record.js";
import { validateKnowledgeEvidence } from "../../src/server/knowledge/evidence.js";
import type { FileOriginalQueries } from "../../src/server/content-sources/reader.js";
import type { KnowledgeDraftInput } from "../../src/shared/knowledge/contracts.js";
import type { KnowledgeRecord, KnowledgeTaskInput } from "../../src/shared/knowledge/tasks.js";

/** Real original, Git output, workflow admission and catalog; no model or external services participate. */
export async function nativeKnowledgeFixture(kind: "web" | "slides" = "web") {
  const f = await projectFileApiFixture(),
    root = await mkdtemp(join(tmpdir(), "panda-native-approved-")),
    db = openKnowledgeDatabase(join(root, "data", "knowledge.sqlite")),
    ledger = knowledgeTaskLedger(db),
    catalog = new KnowledgeCatalogStore(db),
    files = knowledgeTaskFiles(join(root, "knowledge", "tasks")),
    app = f.application(),
    content = new FileDocumentKnowledgeContent(app.projectContent, app.projectContent, app.originals),
    scope = { owner: "alice", project: "project-1" };
  try {
    const saved = await app.creations.save(scope.owner, scope.project, {
        id: "c-" + randomUUID(),
        operationId: randomUUID(),
        expectedVersion: null,
        kind,
        name: kind === "web" ? "guide.html" : "guide.pptx",
        title: "Verified native source",
        locale: "en",
        bytes:
          kind === "web"
            ? Buffer.from(
                "<main><h1>Native evidence</h1><p>Verified original content</p><script>Hidden script</script></main>",
              )
            : Buffer.from(officeFixture({ slides: 2 }).bytes()),
        resources: [{ name: "figure.png", bytes: Buffer.from("Verified native resource") }],
      }),
      selection = { project: scope.project, ids: [saved.asset.id], contentKinds: [kind] },
      captured = await content.capture(scope.owner, selection),
      input: KnowledgeTaskInput = {
        schema: 1,
        scope: selection,
        purpose: "Summarize saved native evidence",
        sources: captured.sources,
        sourceCommit: captured.commit,
        target: captured.target,
        profile: { id: "test", engineId: "codex", model: "synthetic", activeTimeoutMs: 180000 },
      },
      inputDigest = await files.putInput(input),
      dialogueDigest = await files.putDialogue({ questions: [], answers: [] }),
      task = ledger.create(
        {
          owner: scope.owner,
          project: scope.project,
          title: "Reviewed native evidence",
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
      source = input.sources[0]!,
      draft: KnowledgeDraftInput = {
        schema: 1,
        title: "Reviewed native knowledge",
        summary: "A verified saved original.",
        claims: [
          {
            id: "claim",
            kind: "source",
            text: "Evidence is saved.",
            evidence: [
              {
                sourceId: source.id,
                version: source.version,
                quote: kind === "web" ? "Verified original content" : "Hello world",
                start: source.text.indexOf(kind === "web" ? "Verified original content" : "Hello world"),
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
    ledger.admit(scope.owner, task.id, 1, outputDigest, 1004);
    const receipt = await content.save(scope.owner, input, record),
      projection = await content.projection(scope.owner, input, record, receipt),
      admission = { ...scope, taskId: task.id, outputDigest, inputDigest, receipt };
    return {
      ...f,
      app,
      root,
      db,
      ledger,
      catalog,
      files,
      content,
      scope,
      saved,
      input,
      record,
      projection,
      admission,
      reader: (originals: FileOriginalQueries = app.originals) =>
        new FileApprovedKnowledgeReader(
          catalog,
          async () => app.projectContent,
          () => {},
          async () => originals,
        ),
      complete: () => ledger.complete(scope.owner, task.id, outputDigest, receipt, 1005, projection),
      close: async () => {
        db.close();
        await f.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
