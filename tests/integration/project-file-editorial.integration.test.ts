import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { projectEditorialFixture } from "../support/project-editorial-fixture.js";
import { waitFor } from "../support/app-fixture.mjs";

const history = (project: string) =>
  "/api/document-editorial/history?" + new URLSearchParams({ document: "doc-1", project });

test.concurrent(
  "scoped file spacing reviews apply selected edits once while preserving formatting and task/source separation",
  async () => {
    const t = await projectEditorialFixture({ image: true });
    try {
      const prepared = await t.prepare();
      expect(prepared.status).toBe(201);
      const detail = prepared.body;
      expect(detail.proposal.source.projectId).toBe(t.projectId);
      expect(detail.proposal.edits).toHaveLength(2);
      expect((await t.prepare(detail.proposal.id)).body).toEqual(detail);
      expect((await t.f.call(history(t.projectId))).body.reviews).toHaveLength(1);
      const reads = t.state.legacyCalls;
      expect((await t.f.call(history("foreign-project"))).status).toBe(404);
      expect(t.state.legacyCalls).toBe(reads);
      const input = { id: detail.proposal.id, digest: detail.digest, selected: [detail.proposal.edits[0].id] };
      const [first, repeat] = await Promise.all([
        t.f.call("/api/document-editorial/accept", "POST", input),
        t.f.call("/api/document-editorial/accept", "POST", input),
      ]);
      expect(first.status).toBe(200);
      expect(repeat.status).toBe(200);
      expect(repeat.body.receipt).toEqual(first.body.receipt);
      expect(first.body.receipt.commit).toMatch(/^[a-f0-9]{40}$/);
      const saved = await t.f.application().queries.detail(t.projectId, t.documentId);
      expect(saved.document.revision).toBe(3);
      expect(saved.revision.body!.document.content![0]!.content![0]!.text).toBe("This are a test.  ");
      expect(saved.revision.body!.document.content![0]!.content![0]!.marks).toEqual([{ type: "bold" }]);
      expect(saved.revision.body!.document.content![1]).toEqual(
        t.checkpoint.detail.revision.body!.document.content![1],
      );
      expect(saved.revision.body!.document.content![2]).toEqual(
        t.checkpoint.detail.revision.body!.document.content![2],
      );
      expect((await t.f.application().assets.content(t.projectId, t.asset!.id)).asset.digest).toBe(t.asset!.digest);
      expect(
        (await t.f.snapshots.entries(await t.f.snapshots.head())).some((entry) => entry.path.endsWith(".png")),
      ).toBe(false);
      expect((await t.f.call(history(t.projectId))).body.reviews[0].applied).toBe(true);
      expect(t.state.ioInTransaction).toBe(false);
      expect(t.state.modelCalls).toBe(0);
    } finally {
      await t.close();
    }
  },
  30000,
);

test.concurrent(
  "a torn task receipt reconciles an existing Git edit after restart without changing later drafts",
  async () => {
    const t = await projectEditorialFixture();
    try {
      const detail = (await t.prepare()).body,
        selected = [detail.proposal.edits[0].id],
        input = { id: detail.proposal.id, digest: detail.digest, selected };
      t.db().exec(
        "CREATE TRIGGER reject_application BEFORE INSERT ON editorial_applications BEGIN SELECT RAISE(ABORT,'disposable receipt failure'); END",
      );
      expect((await t.f.call("/api/document-editorial/accept", "POST", input)).status).toBe(503);
      const applied = await t.f.application().queries.editor(t.projectId, t.documentId);
      expect(applied.saved.document.revision).toBe(3);
      expect(t.db().query("SELECT COUNT(*) AS count FROM editorial_application_intents").get()).toEqual({ count: 1 });
      expect(t.db().query("SELECT COUNT(*) AS count FROM editorial_applications").get()).toEqual({ count: 0 });
      await t.f.application().editor.autosave("writer", t.projectId, t.documentId, {
        operationId: randomUUID(),
        version: applied.draft.version,
        baseRevisionId: applied.draft.baseRevisionId,
        working: { ...applied.working, title: "Later unsaved draft" },
      });
      const head = await t.f.snapshots.head();
      t.db().exec("DROP TRIGGER reject_application");
      await t.restart();
      const reconciled = await t.f.call("/api/document-editorial/detail?id=" + detail.proposal.id);
      expect(reconciled.status).toBe(200);
      expect(reconciled.body.receipt.applied.revisionId).toBe(applied.saved.revision.id);
      expect(reconciled.body.receipt.commit).toBe(head);
      expect(reconciled.body.pending).toBeUndefined();
      expect(await t.f.snapshots.head()).toBe(head);
      expect((await t.f.application().queries.editor(t.projectId, t.documentId)).working.title).toBe(
        "Later unsaved draft",
      );
      expect((await t.f.call("/api/document-editorial/accept", "POST", input)).body.receipt).toEqual(
        reconciled.body.receipt,
      );
      expect(
        (
          await t.f.call("/api/document-editorial/accept", "POST", {
            ...input,
            selected: [detail.proposal.edits[1].id],
          })
        ).status,
      ).toBe(409);
      expect(t.db().query("SELECT COUNT(*) AS count FROM editorial_applications").get()).toEqual({ count: 1 });
      expect(t.state.ioInTransaction).toBe(false);
    } finally {
      await t.close();
    }
  },
  30000,
);

test.concurrent(
  "dirty file drafts block application and preserve the confirmed selection for an explicit retry",
  async () => {
    const t = await projectEditorialFixture();
    try {
      const detail = (await t.prepare()).body,
        editor = await t.f.application().queries.editor(t.projectId, t.documentId),
        input = { id: detail.proposal.id, digest: detail.digest, selected: [detail.proposal.edits[0].id] };
      const draft = await t.f.application().editor.autosave("writer", t.projectId, t.documentId, {
        operationId: randomUUID(),
        version: editor.draft.version,
        baseRevisionId: editor.draft.baseRevisionId,
        working: { ...editor.working, title: "Do not replace this draft" },
      });
      const blocked = await t.f.call("/api/document-editorial/accept", "POST", input);
      expect(blocked.status).toBe(409);
      expect(blocked.body.messageId).toBe("editorial.workingCopyChanged");
      const pending = await t.f.call("/api/document-editorial/detail?id=" + detail.proposal.id);
      expect(pending.body.pending.selected).toEqual(input.selected);
      expect((await t.f.application().queries.editor(t.projectId, t.documentId)).working.title).toBe(
        "Do not replace this draft",
      );
      expect((await t.f.application().queries.record(t.projectId, t.documentId)).revision).toBe(2);
      await t.f.application().editor.discard("writer", t.projectId, t.documentId, {
        operationId: randomUUID(),
        version: draft.version,
        baseRevisionId: draft.baseRevisionId,
      });
      expect((await t.f.call("/api/document-editorial/accept", "POST", input)).status).toBe(200);
      expect((await t.f.application().queries.record(t.projectId, t.documentId)).revision).toBe(3);
      t.f.grants.clear();
      expect((await t.f.call("/api/document-editorial/detail?id=" + detail.proposal.id)).status).toBe(404);
      expect(t.state.legacyCalls).toBe(0);
    } finally {
      await t.close();
    }
  },
  30000,
);

for (const mode of ["proofread", "rewrite"] as const)
  test.concurrent(
    `file ${mode} tasks persist project scope and return review proposals without overwriting originals`,
    async () => {
      const t = await projectEditorialFixture();
      try {
        const input = {
          id: randomUUID(),
          projectId: t.projectId,
          documentId: t.documentId,
          revisionId: t.checkpoint.detail.revision.id,
          profileId: "review",
          mode,
        };
        const submitted = await t.f.call("/api/document-editorial/jobs", "POST", input);
        expect(submitted.status).toBe(202);
        expect(submitted.body.job.source.projectId).toBe(t.projectId);
        await t.restart();
        expect((await t.f.call("/api/document-editorial/jobs", "POST", input)).body.job.id).toBe(input.id);
        t.feature().start();
        const done = await waitFor(async () => {
          const job = (await t.f.call("/api/document-editorial/jobs/detail?id=" + input.id)).body.job;
          return job.state === "succeeded" ? job : false;
        });
        expect(t.state.modelCalls).toBe(1);
        const review = (await t.f.call("/api/document-editorial/detail?id=" + done.proposalId)).body;
        expect(review.proposal.source).toEqual(done.source);
        expect(review.proposal.mode).toBe(mode);
        expect(review.proposal.edits[0].rule).toBe(mode === "rewrite" ? "rewrite" : "grammar");
        expect(review.proposal.producer.kind).toBe("model");
        expect((await t.f.application().queries.record(t.projectId, t.documentId)).revision).toBe(2);
        const applied = await t.f.call("/api/document-editorial/accept", "POST", {
          id: review.proposal.id,
          digest: review.digest,
          selected: review.proposal.edits.map((edit: { id: string }) => edit.id),
        });
        expect(applied.status).toBe(200);
        expect(
          (await t.f.application().queries.detail(t.projectId, t.documentId)).revision.body!.document.content![0]!
            .content![0]!.text,
        ).toBe("This is  a test.  ");
        expect(t.state.ioInTransaction).toBe(false);
      } finally {
        await t.close();
      }
    },
    30000,
  );
