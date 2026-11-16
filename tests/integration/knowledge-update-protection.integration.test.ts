import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { knowledgeCatalogFixture } from "../support/knowledge-catalog-fixture.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { taskKnowledgeContext, previousSourceId } from "../../src/server/knowledge/tasks/evidence-context.js";
import { knowledgeReviewStore } from "../../src/server/knowledge/storage/review-store.js";
import { projectKnowledgeFile, projectKnowledgeMarkdown } from "../../src/server/project-content/paths.js";
import { documentAuthor } from "../../src/server/documents/files/commands.js";
import { knowledgeRecordVersion, knowledgeRecord } from "../../src/server/knowledge/tasks/record.js";
import { knowledgeValueDigest } from "../../src/server/knowledge/identity.js";
import { knowledgeMarkdown } from "../../src/server/knowledge/tasks/markdown.js";
import { cliContentCommands } from "../../src/server/cli/integration/content.js";
import type { KnowledgeRecord } from "../../src/shared/knowledge/tasks.js";
import type { KnowledgeReviewReport } from "../../src/shared/knowledge/review.js";

async function fixture() {
  const f = await knowledgeCatalogFixture();
  f.complete();
  const feature = createKnowledgeFeature({
      stateRoot: f.root,
      content: f.content,
      documents: async () => f.documents.application().projectContent,
      owner: () => f.owner,
      available: () => true,
      report() {},
      profile: async () => ({ id: "test", engineId: "codex", model: "synthetic", activeTimeoutMs: 1000 }),
      engine: () => {
        throw Error("This fixture never requests inference");
      },
    }),
    project = f.input.scope.project;
  const markdown = () => readFile(join(f.documents.owned.directory, projectKnowledgeMarkdown(f.record.id)), "utf8"),
    editMarkdown = async (text: string) =>
      f.documents.application().projectContent.write(project, (p) =>
        p.coordinator.plan(
          {
            operationId: randomUUID(),
            author: documentAuthor(f.owner),
            message: "Edit saved knowledge text",
            intent: "manual-readable-edit",
          },
          async () => ({ changes: [{ path: projectKnowledgeMarkdown(f.record.id), content: text }] }),
        ),
      ),
    submit = () =>
      feature.service.submit(f.owner, {
        id: randomUUID(),
        project,
        ids: f.input.scope.ids,
        purpose: "Preserve manual guidance while updating the original facts.",
      });
  async function draft(id: string, preserve?: string) {
    const task = f.ledger.get(f.owner, id),
      input = await f.files.input(task.inputDigest),
      dialogue = await f.files.dialogue(task.dialogueDigest),
      context = await taskKnowledgeContext(f.files, input, dialogue),
      source = context.find((s) => s.kind === "asset")!,
      historical = context.find((s) => s.id === previousSourceId(input))!,
      quote = preserve ?? historical?.text.slice(0, 80) ?? "",
      digest = await f.files.putDraft({
        schema: 1,
        title: "Updated reviewed knowledge",
        summary: "Current facts and preserved manual guidance.",
        claims: [
          {
            id: "current",
            kind: "source",
            text: source.text,
            evidence: [{ sourceId: source.id, version: source.version, quote: source.text.slice(0, 20) }],
          },
          ...(historical
            ? [
                {
                  id: "manual",
                  kind: "user" as const,
                  text: quote,
                  evidence: [{ sourceId: historical.id, version: historical.version, quote }],
                },
              ]
            : []),
        ],
        uncertainties: [],
      }),
      claim = f.ledger.claim(Date.now(), 30000)!;
    expect(claim.task.id).toBe(id);
    const execution = f.ledger.bind(claim.lease, { sessionId: "isolated", runId: "run" }, Date.now());
    f.ledger.draft(execution, digest, Date.now());
    return feature.service.detail(f.owner, id);
  }
  return {
    ...f,
    feature,
    project,
    markdown,
    editMarkdown,
    writeKnowledge: (json: string, markdown: string) =>
      f.documents.application().projectContent.write(project, (p) =>
        p.coordinator.plan(
          {
            operationId: randomUUID(),
            author: documentAuthor(f.owner),
            message: "Update saved knowledge files",
            intent: "knowledge-edit",
          },
          async () => ({
            changes: [
              { path: projectKnowledgeFile(f.record.id), content: json },
              { path: projectKnowledgeMarkdown(f.record.id), content: markdown },
            ],
          }),
        ),
      ),
    submit,
    draft,
    async close() {
      await feature.close();
      await f.close();
    },
  };
}

test("a human-reviewed target stays unchanged until its exact saved state is explicitly approved", async () => {
  const f = await fixture();
  try {
    const before = await f.markdown();
    await f.feature.reviewSettings.configure(f.owner, f.project, { automatic: true, revision: 0 });
    const task = await f.submit(),
      detail = await f.draft(task.id);
    expect(detail.previous?.reviewRequired).toBe(true);
    expect(f.ledger.get(f.owner, task.id).autoEligible).toBe(0);
    expect(knowledgeReviewStore(f.db).claim(Date.now())).toBeNull();
    expect((await f.feature.service.previous(f.owner, task.id)).previous.markdown).toBe(before);
    await expect(
      f.feature.service.approve(f.owner, task.id, { revision: detail.task.reviewRevision }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.feature.service.approve(f.owner, task.id, {
        revision: detail.task.reviewRevision,
        previousState: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.markdown()).toBe(before);
    const approved = await f.feature.service.approve(f.owner, task.id, {
      revision: detail.task.reviewRevision,
      previousState: detail.previous!.state,
    });
    expect(approved.state).toBe("completed");
    const record = JSON.parse(
      await readFile(join(f.documents.owned.directory, projectKnowledgeFile(f.record.id)), "utf8"),
    );
    expect(record.previousVersion).toBe(f.record.version);
    expect(record.sources.some((s: { kind: string }) => s.kind === "user-input")).toBe(true);
    expect((await f.feature.service.previous(f.owner, task.id)).previous.markdown).toBe(before);
    await expect(f.feature.service.previous("another-owner", task.id)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 30000);

test("manual readable edits are preserved as historical user context and can be cited by the new draft", async () => {
  const f = await fixture();
  try {
    const manual = "Manual decision: Keep external access disabled.",
      before = await f.markdown();
    await f.editMarkdown(before + "\n\n" + manual + "\n");
    const task = await f.submit(),
      detail = await f.draft(task.id, manual);
    expect((await f.feature.service.previous(f.owner, task.id)).previous.markdown).toContain(manual);
    expect(detail.draft!.claims.find((c) => c.id === "manual")).toMatchObject({ kind: "user", text: manual });
    expect(
      (
        await f.feature.service.approve(f.owner, task.id, {
          revision: detail.task.reviewRevision,
          previousState: detail.previous!.state,
        })
      ).state,
    ).toBe("completed");
    const record = JSON.parse(
      await readFile(join(f.documents.owned.directory, projectKnowledgeFile(f.record.id)), "utf8"),
    );
    expect(record.draft.claims.find((c: { id: string }) => c.id === "manual").text).toBe(manual);
  } finally {
    await f.close();
  }
}, 30000);

test("a readable edit made after capture rejects the old acknowledgement and preserves the newer file", async () => {
  const f = await fixture();
  try {
    const task = await f.submit(),
      detail = await f.draft(task.id),
      changed = (await f.markdown()) + "\nNew manual change after capture.\n";
    await f.editMarkdown(changed);
    await expect(
      f.feature.service.approve(f.owner, task.id, {
        revision: detail.task.reviewRevision,
        previousState: detail.previous!.state,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.feature.service.status(f.owner, task.id)).toMatchObject({
      state: "stale",
      failure: "targetChanged",
    });
    expect(await f.markdown()).toBe(changed);
  } finally {
    await f.close();
  }
}, 30000);

function automatic(record: KnowledgeRecord) {
  const value = structuredClone(record),
    report: KnowledgeReviewReport = {
      schema: 1,
      verdict: "approve",
      summary: "Reviewed all claims.",
      checks: { faithfulness: true, coverage: true, separation: true, clarity: true, contradictions: true },
      claims: value.draft.claims.map((claim) => ({
        id: claim.id,
        supported: true,
        reason: "Supported by the exact source.",
      })),
      issues: [],
      id: randomUUID(),
      taskId: value.taskId,
      taskRevision: 1,
      policyRevision: 1,
      inputDigest: "a".repeat(64),
      dialogueDigest: "b".repeat(64),
      draftDigest: "c".repeat(64),
      engineId: "codex",
      model: "synthetic",
      reviewedAt: value.approvedAt,
    };
  value.approval = {
    mode: "automatic",
    reviewId: report.id,
    policyRevision: 1,
    reportDigest: knowledgeValueDigest(report),
    engineId: "codex",
    model: "synthetic",
  };
  value.review = report;
  value.version = knowledgeRecordVersion(value);
  return knowledgeRecord(value);
}

test("canonical automatically reviewed knowledge remains eligible for automatic refresh", async () => {
  const f = await fixture();
  try {
    const prior = automatic(f.record);
    await f.writeKnowledge(JSON.stringify(prior) + "\n", knowledgeMarkdown(prior));
    await f.feature.reviewSettings.configure(f.owner, f.project, { automatic: true, revision: 0 });
    const task = await f.submit(),
      detail = await f.draft(task.id),
      row = f.ledger.get(f.owner, task.id),
      input = await f.files.input(row.inputDigest);
    expect(detail.previous?.reviewRequired).toBe(false);
    expect(task.manualReviewRequired).toBe(false);
    expect(row.autoEligible).toBe(1);
    expect(knowledgeReviewStore(f.db).claim(Date.now())?.review.taskId).toBe(task.id);
    const output = automatic({
        ...prior,
        taskId: task.id,
        sourceCommit: input.sourceCommit,
        previousVersion: prior.version,
        draft: detail.draft!,
      }),
      receipt = await f.content.save(f.owner, input, output);
    expect(receipt.version).toBe(output.version);
    expect(await f.markdown()).toBe(knowledgeMarkdown(output));
  } finally {
    await f.close();
  }
}, 30000);

test("manual readable edits protect an automatically reviewed record from automatic refresh", async () => {
  const f = await fixture();
  try {
    const prior = automatic(f.record),
      markdown = knowledgeMarkdown(prior) + "\nManual operator guidance.\n";
    await f.writeKnowledge(JSON.stringify(prior) + "\n", markdown);
    await f.feature.reviewSettings.configure(f.owner, f.project, { automatic: true, revision: 0 });
    const task = await f.submit(),
      detail = await f.draft(task.id);
    expect(task.manualReviewRequired).toBe(true);
    expect(detail.previous?.reviewRequired).toBe(true);
    expect(knowledgeReviewStore(f.db).claim(Date.now())).toBeNull();
    expect((await f.feature.service.previous(f.owner, task.id)).previous.markdown).toBe(markdown);
  } finally {
    await f.close();
  }
}, 30000);

test("a structured-file edit invalidates confirmation even when its semantic record version stays equal", async () => {
  const f = await fixture();
  try {
    const task = await f.submit(),
      detail = await f.draft(task.id),
      markdown = await f.markdown(),
      json = JSON.stringify(f.record, null, 2) + "\n";
    await f.writeKnowledge(json, markdown);
    await expect(
      f.feature.service.approve(f.owner, task.id, {
        revision: detail.task.reviewRevision,
        previousState: detail.previous!.state,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(join(f.documents.owned.directory, projectKnowledgeFile(f.record.id)), "utf8")).toBe(json);
    expect(await f.markdown()).toBe(markdown);
    expect((await f.feature.service.status(f.owner, task.id)).state).toBe("stale");
  } finally {
    await f.close();
  }
}, 30000);

test("uncommitted readable changes are rejected without normalizing or replacing the user's bytes", async () => {
  const f = await fixture();
  try {
    const changed = (await f.markdown()) + "\nUncommitted human guidance.\n";
    await writeFile(join(f.documents.owned.directory, projectKnowledgeMarkdown(f.record.id)), changed);
    await expect(f.submit()).rejects.toMatchObject({ code: "conflict" });
    expect(await f.markdown()).toBe(changed);
    expect(await f.feature.service.list(f.owner, f.project)).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

test("oversized historical processing fails before admission without consuming a task or model run", async () => {
  const f = await fixture();
  try {
    const markdown = "Manual historical knowledge.\n".repeat(21000);
    await f.editMarkdown(markdown);
    await expect(f.submit()).rejects.toMatchObject({ code: "contextLimit" });
    expect(await f.feature.service.list(f.owner, f.project)).toHaveLength(1);
    expect(await f.markdown()).toBe(markdown);
  } finally {
    await f.close();
  }
}, 30000);

test("UTF-8 BOM bytes remain part of both saved comparison files and the replacement guard", async () => {
  const f = await fixture();
  try {
    const json = "\uFEFF" + JSON.stringify(f.record) + "\n",
      markdown = "\uFEFF" + (await f.markdown());
    await f.writeKnowledge(json, markdown);
    const task = await f.submit(),
      row = f.ledger.get(f.owner, task.id),
      input = await f.files.input(row.inputDigest),
      previous = await f.files.previous(input.target.previous!.digest);
    expect(previous.json).toBe(json);
    expect(previous.markdown).toBe(markdown);
    expect((await f.feature.service.previous(f.owner, task.id)).previous.markdown).toBe(markdown);
    const detail = await f.draft(task.id);
    await f.writeKnowledge(json.slice(1), markdown);
    await expect(
      f.feature.service.approve(f.owner, task.id, {
        revision: detail.task.reviewRevision,
        previousState: detail.previous!.state,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.markdown()).toBe(markdown);
  } finally {
    await f.close();
  }
}, 30000);

test("CLI comparison and confirmation retain task ownership, exact project and target-state guards", async () => {
  const f = await fixture();
  try {
    const task = await f.submit(),
      detail = await f.draft(task.id),
      signal = new AbortController().signal,
      commands = cliContentCommands({
        authorize: (owner, project) => f.content.authorize(owner, project),
        documents: async () => f.documents.application(),
        knowledge: f.feature.service,
        records: f.feature.records,
        search: async () => ({}),
        searchStatus: async () => ({}),
      });
    const data = (await commands.execute(
      f.owner,
      "knowledge.previous",
      { project: f.project, id: task.id, offset: 0 },
      signal,
    )) as { previous: { markdown: string; state: string; next: number | null } };
    expect(data.previous.markdown).toBe(await f.markdown());
    expect(data.previous.next).toBeNull();
    await expect(
      commands.execute("another-owner", "knowledge.previous", { project: f.project, id: task.id }, signal),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(
      commands.execute(f.owner, "knowledge.previous", { project: f.project, id: task.id, offset: -1 }, signal),
    ).rejects.toMatchObject({ code: "invalidInput" });
    await expect(
      commands.execute(
        f.owner,
        "knowledge.approve",
        { project: f.project, id: task.id, revision: detail.task.reviewRevision },
        signal,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const updated = (await commands.execute(
      f.owner,
      "knowledge.approve",
      { project: f.project, id: task.id, revision: detail.task.reviewRevision, previousState: data.previous.state },
      signal,
    )) as { task: { state: string } };
    expect(updated.task.state).toBe("completed");
  } finally {
    await f.close();
  }
}, 30000);
test("the file writer independently rejects an automatic legacy overwrite of a manual target", async () => {
  const f = await fixture();
  try {
    const captured = await f.content.capture(f.owner, f.input.scope),
      input = { ...f.input, sourceCommit: captured.commit, target: captured.target },
      value = automatic({
        ...f.record,
        taskId: randomUUID(),
        sourceCommit: captured.commit,
        previousVersion: f.record.version,
      }),
      before = await f.markdown();
    await expect(f.content.save(f.owner, input, value)).rejects.toMatchObject({ reason: "targetChanged" });
    expect(await f.markdown()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);

test("a pending legacy manual update must capture the protected target before it can replace human knowledge", async () => {
  const f = await fixture();
  try {
    const captured = await f.content.capture(f.owner, f.input.scope),
      input = { ...f.input, sourceCommit: captured.commit, target: captured.target },
      record = { ...f.record, taskId: randomUUID(), sourceCommit: captured.commit, previousVersion: f.record.version },
      before = await f.markdown();
    record.version = knowledgeRecordVersion(record);
    await expect(f.content.save(f.owner, input, record)).rejects.toMatchObject({ reason: "targetChanged" });
    expect(await f.markdown()).toBe(before);
  } finally {
    await f.close();
  }
}, 30000);
