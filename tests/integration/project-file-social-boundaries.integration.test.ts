import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SocialPayload } from "../../src/shared/delivery/social.js";
import { projectSocialFixture } from "../support/project-social-fixture.js";

test.concurrent(
  "file project revocation during asynchronous source authorization leaves a plan unconfirmed and unqueued",
  async () => {
    const f = await projectSocialFixture();
    try {
      const plan = await f.prepare();
      f.state.afterRecord = () => {
        f.t.f.grants.clear();
        f.state.afterRecord = null;
      };
      await expect(f.submit(plan)).rejects.toThrow("notFound");
      expect(f.requests).toEqual([]);
      expect(f.t.db().query("SELECT phase FROM publication_jobs WHERE id=?").get(plan.plan.id)).toEqual({
        phase: "prepared",
      });
      expect(
        f.t.db().query("SELECT COUNT(*) AS count FROM publication_confirmations WHERE jobId=?").get(plan.plan.id),
      ).toEqual({ count: 0 });
      expect(f.state.ioInTransaction).toBe(false);
      expect(f.state.legacyCalls).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "a file source change during a Thread retains the first acknowledgement and blocks the next Post",
  async () => {
    let started!: () => void,
      release!: () => void,
      writes = 0;
    const began = new Promise<void>((done) => {
        started = done;
      }),
      response = new Promise<void>((done) => {
        release = done;
      });
    const f = await projectSocialFixture({
      async respond(path, body) {
        if (path === "/2/media/upload") return { data: { id: "501", expires_after_secs: 600 } };
        if (path === "/2/media/metadata") return { data: { id: body!.id } };
        writes++;
        started();
        await response;
        return { data: { id: String(200 + writes), text: String(body!.text) } };
      },
    });
    try {
      const editor = await f.t.f.application().queries.editor(f.t.projectId, f.t.documentId),
        working = structuredClone(editor.working);
      working.body!.document.content![0]!.content![0]!.text =
        "A reviewed and immutable passage with an explicit source version. ".repeat(15);
      const draft = await f.t.f.application().editor.autosave("writer", f.t.projectId, f.t.documentId, {
        operationId: randomUUID(),
        version: editor.draft.version,
        baseRevisionId: editor.draft.baseRevisionId,
        working,
      });
      await f.t.f.application().editor.save("writer", f.t.projectId, f.t.documentId, {
        operationId: randomUUID(),
        revisionId: editor.saved.revision.id,
        draftVersion: draft.version,
      });
      const plan = await f.prepare("x-thread");
      const content = (plan.plan.payload as unknown as SocialPayload).content;
      expect(content.format).toBe("x-thread");
      expect(content.format !== "x-article" && content.posts.length > 1).toBe(true);
      await f.submit(plan);
      await began;
      const current = await f.t.f.application().queries.editor(f.t.projectId, f.t.documentId),
        changed = await f.t.f.application().editor.autosave("writer", f.t.projectId, f.t.documentId, {
          operationId: randomUUID(),
          version: current.draft.version,
          baseRevisionId: current.draft.baseRevisionId,
          working: { ...current.working, title: "A later human change" },
        });
      await f.t.f.application().editor.save("writer", f.t.projectId, f.t.documentId, {
        operationId: randomUUID(),
        revisionId: current.saved.revision.id,
        draftVersion: changed.version,
      });
      release();
      await f.feature().idle();
      const stopped = await f.feature().service.detail("owner", "x-post", plan.plan.id);
      expect(stopped.phase).toBe("failed");
      expect(stopped.error).toBe("staleSource");
      expect(stopped.steps.filter((step) => step.operation === "post.create")).toHaveLength(1);
      expect(stopped.steps.find((step) => step.operation === "post.create")!.outcome).toBe("succeeded");
      expect(writes).toBe(1);
      expect(f.state.ioInTransaction).toBe(false);
    } finally {
      release();
      await f.close();
    }
  },
  30000,
);
