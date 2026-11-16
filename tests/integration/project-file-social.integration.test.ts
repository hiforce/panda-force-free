import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SocialPayload } from "../../src/shared/delivery/social.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import { projectSocialFixture } from "../support/project-social-fixture.js";

for (const format of ["x-post", "x-thread"] as const)
  test.concurrent(
    "file " +
      format +
      " publishes only explicitly confirmed owned snapshots and retains its scoped receipt across restart",
    async () => {
      const f = await projectSocialFixture();
      try {
        const head = await f.t.f.snapshots.head(),
          plan = await f.prepare(format),
          payload = plan.plan.payload as unknown as SocialPayload;
        expect(plan.phase).toBe("prepared");
        expect(f.requests).toEqual([]);
        expect(plan.plan.sourceProjectId).toBe(f.t.projectId);
        expect(payload.source.projectId).toBe(f.t.projectId);
        expect(payload.source.commit).toBe(head);
        expect(payload.content.format).toBe(format);
        const duplicate = await f.feature().service.prepare("owner", {
          id: randomUUID(),
          variantId: payload.source.variantId,
          connectionId: f.target.id,
        });
        expect(duplicate.plan).toEqual(plan.plan);
        expect(
          (await f.t.f.call("/api/social-publications/context?variant=" + payload.source.variantId)).body
            .sourceProjectId,
        ).toBe(f.t.projectId);
        expect(
          (await f.t.f.call("/api/social-publications?space=space-1&project=project-1")).body.publications,
        ).toHaveLength(1);
        expect((await f.t.f.call("/api/social-publications?space=space-1&project=foreign")).status).toBe(404);
        await f.submit(plan);
        await f.feature().idle();
        const done = await f.feature().service.detail("owner", "x-post", plan.plan.id);
        expect(done.phase).toBe("completed");
        expect(f.requests.filter((r) => r.path === "/2/tweets")).toHaveLength(
          payload.content.format === "x-article" ? 0 : payload.content.posts.length,
        );
        expect(
          Buffer.from(String(f.requests.find((r) => r.path === "/2/media/upload")!.body!.media), "base64"),
        ).toEqual(f.t.bytes);
        expect(f.requests.filter((r) => r.path === "/2/media/upload")).toHaveLength(1);
        expect(f.state.ioInTransaction).toBe(false);
        expect(f.state.legacyCalls).toBe(0);
        expect(await f.t.f.snapshots.head()).toBe(head);
        await f.restart();
        expect(await f.feature().service.detail("owner", "x-post", plan.plan.id)).toEqual(done);
        const count = f.requests.length;
        await f.submit(plan);
        await f.feature().idle();
        expect(f.requests).toHaveLength(count);
      } finally {
        await f.close();
      }
    },
    30000,
  );

test.concurrent(
  "file Article creates a draft and requires a separate confirmed public publication with the same source scope",
  async () => {
    const f = await projectSocialFixture();
    try {
      const plan = await f.prepare("x-article");
      expect(plan.plan.kind).toBe("x-article-draft");
      await expect(
        f.feature().service.prepareArticlePublish("owner", { id: randomUUID(), draftId: plan.plan.id }),
      ).rejects.toThrow("draftRequired");
      await f.submit(plan);
      await f.feature().idle();
      expect(f.requests.filter((r) => r.path.endsWith("/draft"))).toHaveLength(1);
      expect(f.requests.filter((r) => r.path.endsWith("/publish"))).toHaveLength(0);
      const publication = await f
        .feature()
        .service.prepareArticlePublish("owner", { id: randomUUID(), draftId: plan.plan.id });
      expect(publication.plan.kind).toBe("x-article-publish");
      expect(publication.plan.sourceProjectId).toBe(f.t.projectId);
      await f.restart();
      expect(f.requests.filter((r) => r.path.endsWith("/publish"))).toHaveLength(0);
      await f.submit(publication);
      await f.feature().idle();
      expect((await f.feature().service.detail("owner", "x-article-publish", publication.plan.id)).phase).toBe(
        "completed",
      );
      expect(f.requests.filter((r) => r.path.endsWith("/publish"))).toHaveLength(1);
      expect(f.state.ioInTransaction).toBe(false);
      expect(f.state.legacyCalls).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);

test.concurrent(
  "file publication unknown results and revoked project access cannot grant another dispatch or a legacy fallback",
  async () => {
    const f = await projectSocialFixture({
      async respond(path, body) {
        if (path === "/2/media/upload") return { data: { id: "501", expires_after_secs: 600 } };
        if (path === "/2/media/metadata") return { data: { id: body!.id } };
        throw new RemoteOperationError("platformUnavailable", "unknown");
      },
    });
    try {
      const plan = await f.prepare();
      await f.submit(plan);
      await f.feature().idle();
      const unknown = await f.feature().service.detail("owner", "x-post", plan.plan.id);
      expect(unknown.phase).toBe("needsAttention");
      expect(unknown.steps.at(-1)!.outcome).toBe("pending");
      expect(unknown.steps.at(-1)!.operation).toBe("post.create");
      const count = f.requests.length;
      await f.restart();
      await f.feature().idle();
      expect(f.requests).toHaveLength(count);
      await expect(f.submit(plan, true)).rejects.toThrow("conflict");
      expect(f.requests).toHaveLength(count);
      f.t.f.grants.clear();
      await expect(f.feature().service.detail("owner", "x-post", plan.plan.id)).rejects.toThrow("notFound");
      expect(f.state.legacyCalls).toBe(0);
      expect(f.state.ioInTransaction).toBe(false);
    } finally {
      await f.close();
    }
  },
  30000,
);
