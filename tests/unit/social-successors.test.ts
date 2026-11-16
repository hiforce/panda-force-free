import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { WorkflowRecord } from "../../src/shared/delivery/workflow.js";
import type { SocialPayload } from "../../src/shared/delivery/social.js";
import { socialFixture } from "../support/social-publication-fixture.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";

const binding = (record: WorkflowRecord) => ({
  id: record.plan.id,
  kind: record.plan.kind,
  fingerprint: record.plan.fingerprint,
});
const renew = (record: WorkflowRecord) => ({
  ...binding(record),
  stateToken: record.continuationToken,
  successorId: randomUUID(),
  acceptContinuation: true,
});

test("an expired Thread continues under renewed same-account authorization without repeating confirmed posts", async () => {
  let now = Date.now(),
    reject = true,
    writes = 0;
  const f = await socialFixture(
    "A reviewed and carefully tested implementation with reliable publication receipts. ".repeat(18),
    {
      now: () => now,
      async respond(_path, body) {
        writes++;
        if (reject && writes === 2) throw new RemoteOperationError("rateLimited", "rejected");
        return { data: { id: String(200 + writes), text: body!.text } };
      },
    },
  );
  try {
    const plan = await f.prepare((await f.variant("x-thread")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    const parent = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    now += 86400001;
    f.target.version++;
    await expect(f.submit(parent, true)).rejects.toThrow("planExpired");
    const input = renew(parent),
      child = await f.feature.continuation.prepare("owner", input);
    expect(child.phase).toBe("prepared");
    expect(child.confirmations).toEqual([]);
    expect(writes).toBe(2);
    expect((child.plan.payload as unknown as SocialPayload).target.version).toBe(2);
    expect((child.plan.payload as unknown as SocialPayload).source).toEqual(
      (parent.plan.payload as unknown as SocialPayload).source,
    );
    expect(child.lineage.steps[0]?.result).toEqual(parent.steps[0]?.result);
    expect((await f.feature.continuation.prepare("owner", { ...input, successorId: randomUUID() })).plan.id).toBe(
      child.plan.id,
    );
    await f.restart();
    await f.feature.idle();
    expect(writes).toBe(2);
    reject = false;
    await f.submit(child);
    await f.feature.idle();
    const complete = await f.feature.service.detail("owner", "x-post", child.plan.id);
    expect(complete.phase).toBe("completed");
    const count = (child.plan.payload as unknown as SocialPayload).content;
    expect(count.format).not.toBe("x-article");
    if (count.format !== "x-article") expect(writes).toBe(count.posts.length + 1);
    expect((f.requests[2]!.body as { reply: unknown }).reply).toEqual({ in_reply_to_tweet_id: "201" });
    const original = await f.feature.service.detail("owner", "x-post", parent.plan.id);
    expect(original.plan).toEqual(parent.plan);
    expect(original.steps).toEqual(parent.steps);
    expect(original.confirmations).toEqual(parent.confirmations);
    await expect(f.submit(parent, true)).rejects.toThrow("planSuperseded");
  } finally {
    await f.dispose();
  }
});

test("a successor renews only expired images needed by unfinished posts with monotonic operation generations", async () => {
  let now = Date.now(),
    uploads = 0,
    posts = 0,
    reject = true;
  const f = await socialFixture(undefined, {
    now: () => now,
    async respond(path, body) {
      if (path === "/2/media/upload")
        return { data: { id: String(++uploads), media_key: `3_${uploads}`, expires_after_secs: 10 } };
      if (path === "/2/media/metadata") return { data: { id: body!.id } };
      posts++;
      if (reject && posts === 2) throw new RemoteOperationError("rateLimited", "rejected");
      return { data: { id: String(200 + posts), text: body!.text } };
    },
  });
  try {
    const bytes = await sharp({ create: { width: 10, height: 8, channels: 3, background: "#334477" } })
        .png()
        .toBuffer(),
      asset = await f.documents.assets.upload(f.document.document.id, "image.png", bytes);
    f.save(
      "Six reviewed illustrations.\n\n" +
        Array.from({ length: 6 }, (_, i) => `![Figure ${i + 1}](/api/document-assets/content?id=${asset.id})`).join(
          "\n\n",
        ),
    );
    const plan = await f.prepare((await f.variant("x-thread")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    const parent = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(parent.phase).toBe("failed");
    expect(uploads).toBe(6);
    expect(posts).toBe(2);
    await f.feature.service.cancel("owner", "x-post", parent.plan.id);
    now += 86400001;
    const stopped = await f.feature.service.detail("owner", "x-post", parent.plan.id),
      child = await f.feature.continuation.prepare("owner", renew(stopped));
    expect(child.cancellation).toBeNull();
    expect(stopped.cancellation).not.toBeNull();
    reject = false;
    await f.submit(child);
    await f.feature.idle();
    const complete = await f.feature.service.detail("owner", "x-post", child.plan.id);
    expect(complete.phase).toBe("completed");
    expect(uploads).toBe(8);
    expect(posts).toBe(3);
    expect(complete.steps.filter((step) => step.operation === "media.upload").map((step) => step.key)).toEqual([
      "media.m5.g2.upload",
      "media.m6.g2.upload",
    ]);
    const sends = f.requests.filter((item) => item.path === "/2/tweets");
    expect((sends[2]!.body as { media: unknown; reply: unknown }).media).toEqual({ media_ids: ["7", "8"] });
    expect((sends[2]!.body as { reply: unknown }).reply).toEqual({ in_reply_to_tweet_id: "201" });
    expect((await f.feature.service.detail("owner", "x-post", parent.plan.id)).steps).toEqual(stopped.steps);
  } finally {
    await f.dispose();
  }
});

test("unknown results can be inspected after same-account reauthorization but adoption is bound to that grant version", async () => {
  let text = "",
    writes = 0;
  const f = await socialFixture("A reviewed Post.", {
    async respond(_path, body, method) {
      if (method === "GET")
        return { data: { id: "201", author_id: "123", text, created_at: new Date().toISOString() } };
      writes++;
      text = String(body!.text);
      throw new RemoteOperationError("platformUnavailable", "unknown");
    },
  });
  try {
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    const parent = await f.feature.service.detail("owner", "x-post", plan.plan.id),
      lookup = { ...binding(parent), stepId: parent.steps[0]!.id, remoteId: "201", acceptLookupCosts: true };
    f.target.version++;
    const evidence = await f.feature.recovery.inspect("owner", lookup);
    expect(evidence.status).toBe("match");
    f.target.version++;
    await expect(
      f.feature.recovery.adopt("owner", { ...binding(parent), evidenceId: evidence.id, acceptExistingResult: true }),
    ).rejects.toThrow("recoveryAuthorizationChanged");
    const current = await f.feature.recovery.inspect("owner", lookup);
    const resolved = await f.feature.recovery.adopt("owner", {
      ...binding(parent),
      evidenceId: current.id,
      acceptExistingResult: true,
    });
    await expect(f.submit(resolved, true)).rejects.toThrow("authorizationChanged");
    const child = await f.feature.continuation.prepare("owner", renew(resolved));
    expect(child.lineage.steps[0]?.resolution?.evidenceId).toBe(current.id);
    await f.submit(child);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", child.plan.id)).phase).toBe("completed");
    expect(writes).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("changed accounts or content cannot inherit effects from a prior publication", async () => {
  const f = await socialFixture("Reviewed text.");
  try {
    const parent = await f.prepare((await f.variant("x-post")).variant.id);
    f.target.accountId = "456";
    await expect(f.feature.continuation.prepare("owner", renew(parent))).rejects.toThrow("accountBindingChanged");
    f.target.accountId = "123";
    f.save("Changed source.");
    await expect(f.feature.continuation.prepare("owner", renew(parent))).rejects.toThrow("staleSource");
    expect(f.requests).toHaveLength(0);
    expect((await f.feature.service.detail("owner", "x-post", parent.plan.id)).lineage.successorId).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("a confirmed Article draft survives reauthorization and publishing it remains a separate confirmed workflow", async () => {
  let failPublish = true;
  const f = await socialFixture("An Article paragraph.", {
    async respond(path) {
      if (path.endsWith("/draft")) return { data: { id: "301", title: "Guide" } };
      if (failPublish) throw new RemoteOperationError("rateLimited", "rejected");
      return { data: { post_id: "401" } };
    },
  });
  try {
    const draft = await f.prepare((await f.variant("x-article")).variant.id);
    await f.submit(draft);
    await f.feature.idle();
    f.target.version++;
    const publish = await f.feature.service.prepareArticlePublish("owner", {
      id: randomUUID(),
      draftId: draft.plan.id,
    });
    expect(f.requests).toHaveLength(1);
    await f.submit(publish);
    await f.feature.idle();
    const failed = await f.feature.service.detail("owner", "x-article-publish", publish.plan.id);
    f.target.version++;
    const child = await f.feature.continuation.prepare("owner", renew(failed));
    expect(child.plan.kind).toBe("x-article-publish");
    expect((child.plan.payload as { articleId: string }).articleId).toBe("301");
    failPublish = false;
    await f.submit(child);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-article-publish", child.plan.id)).phase).toBe("completed");
    expect(f.requests.map((item) => item.path)).toEqual([
      "/2/articles/draft",
      "/2/articles/301/publish",
      "/2/articles/301/publish",
    ]);
  } finally {
    await f.dispose();
  }
});

test("a successor can reconcile an unknown reply against its inherited predecessor without sending either Post again", async () => {
  let writes = 0,
    secondText = "";
  const f = await socialFixture("A reviewed continuation keeps the original reply chain intact. ".repeat(7), {
    async respond(_path, body, method) {
      if (method === "GET")
        return {
          data: {
            id: "202",
            author_id: "123",
            text: secondText,
            created_at: new Date().toISOString(),
            referenced_tweets: [{ type: "replied_to", id: "201" }],
          },
        };
      writes++;
      if (writes === 1) return { data: { id: "201", text: body!.text } };
      secondText = String(body!.text);
      throw new RemoteOperationError("platformUnavailable", writes === 2 ? "rejected" : "unknown");
    },
  });
  try {
    const original = await f.prepare((await f.variant("x-thread")).variant.id);
    await f.submit(original);
    await f.feature.idle();
    const child = await f.feature.continuation.prepare(
      "owner",
      renew(await f.feature.service.detail("owner", "x-post", original.plan.id)),
    );
    await f.submit(child);
    await f.feature.idle();
    const unknown = await f.feature.service.detail("owner", "x-post", child.plan.id);
    expect(unknown.phase).toBe("needsAttention");
    expect(unknown.steps).toHaveLength(1);
    expect(unknown.lineage.steps).toHaveLength(1);
    const evidence = await f.feature.recovery.inspect("owner", {
      ...binding(unknown),
      stepId: unknown.steps[0]!.id,
      remoteId: "202",
      acceptLookupCosts: true,
    });
    expect(evidence.status).toBe("match");
    const resolved = await f.feature.recovery.adopt("owner", {
      ...binding(unknown),
      evidenceId: evidence.id,
      acceptExistingResult: true,
    });
    await f.submit(resolved, true);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", child.plan.id)).phase).toBe("completed");
    expect(writes).toBe(3);
  } finally {
    await f.dispose();
  }
});

test("stopped media processing continues by polling the inherited upload without extending its lifetime", async () => {
  let now = Date.now(),
    ready = false;
  const f = await socialFixture("A reviewed figure.", {
    now: () => now,
    async respond(path, body, method) {
      if (method === "GET")
        return {
          data: {
            id: "101",
            expires_after_secs: 999999,
            processing_info: { state: ready ? "succeeded" : "in_progress", check_after_secs: 2 },
          },
        };
      if (path === "/2/media/upload")
        return {
          data: {
            id: "101",
            media_key: "3_101",
            expires_after_secs: 3600,
            processing_info: { state: "pending", check_after_secs: 2 },
          },
        };
      if (path === "/2/media/metadata") return { data: { id: body!.id } };
      return { data: { id: "201", text: body!.text } };
    },
  });
  try {
    const bytes = await sharp({ create: { width: 10, height: 8, channels: 3, background: "#334477" } })
      .png()
      .toBuffer();
    const asset = await f.documents.assets.upload(f.document.document.id, "figure.png", bytes);
    f.save(`A reviewed figure.\n\n![Figure](/api/document-assets/content?id=${asset.id})`);
    const original = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(original);
    await f.feature.idle();
    now += 3000;
    f.feature.wake();
    await f.feature.idle();
    const waiting = await f.feature.service.detail("owner", "x-post", original.plan.id);
    expect(waiting.observations).toHaveLength(1);
    const stopped = await f.feature.service.cancel("owner", "x-post", original.plan.id);
    const child = await f.feature.continuation.prepare("owner", renew(stopped));
    expect(child.lineage.observations).toEqual(waiting.observations);
    ready = true;
    now += 3000;
    await f.restart();
    await f.feature.idle();
    expect(f.requests).toHaveLength(2);
    await f.submit(child);
    await f.feature.idle();
    const completed = await f.feature.service.detail("owner", "x-post", child.plan.id);
    expect(completed.phase).toBe("completed");
    expect(f.requests.filter((request) => request.path === "/2/media/upload")).toHaveLength(1);
    expect(f.requests.filter((request) => request.path === "/2/tweets")).toHaveLength(1);
    expect(completed.lineage.steps[0]?.result).toEqual(waiting.steps[0]!.result);
    expect((await f.feature.service.detail("owner", "x-post", original.plan.id)).observations).toEqual(
      waiting.observations,
    );
    const observation = completed.observations[0]?.result as { media: { expiresAt: number } };
    expect(observation.media.expiresAt).toBe((waiting.steps[0]!.result as { expiresAt: number }).expiresAt);
  } finally {
    await f.dispose();
  }
});
