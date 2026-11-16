import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { socialFixture as fixture } from "../support/social-publication-fixture.js";

test("reviewed thread publication freezes content and chains only confirmed remote IDs; explicit resume skips successful parts", async () => {
  const f = await fixture("Reviewed sentence. ".repeat(45));
  try {
    const variant = await f.variant("x-thread"),
      plan = await f.prepare(variant.variant.id);
    expect(plan.phase).toBe("prepared");
    expect(f.requests).toHaveLength(0);
    const duplicate = await f.prepare(variant.variant.id);
    expect(duplicate.plan.id).toBe(plan.plan.id);
    f.fail("rejected");
    await f.submit(plan);
    await f.feature.idle();
    const failed = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(failed.phase).toBe("failed");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.body).toEqual({
      text: variant.variant.posts[1]!.text,
      reply: { in_reply_to_tweet_id: "201" },
    });
    f.fail(null);
    await f.submit(plan, true);
    await f.feature.idle();
    const finished = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(finished.phase).toBe("completed");
    expect(finished.confirmations.map((confirmation) => confirmation.resume)).toEqual([false, true]);
    expect(
      finished.confirmations.every(
        (confirmation) => confirmation.actor === "owner" && confirmation.fingerprint === plan.plan.fingerprint,
      ),
    ).toBe(true);
    expect(f.requests).toHaveLength(variant.variant.posts.length + 1);
    expect(
      f.requests.filter((request) => (request.body as { text: string }).text === variant.variant.posts[0]!.text),
    ).toHaveLength(1);
    expect(f.requests[2]?.body).toEqual(f.requests[1]?.body);
    expect(f.requests[3]?.body).toEqual({
      text: variant.variant.posts[2]!.text,
      reply: { in_reply_to_tweet_id: "203" },
    });
    await f.submit(plan, true);
    await f.feature.idle();
    expect(f.requests).toHaveLength(variant.variant.posts.length + 1);
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).confirmations).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("Article creation is a draft until a separately confirmed publish plan succeeds", async () => {
  const f = await fixture();
  try {
    const variant = await f.variant("x-article"),
      plan = await f.prepare(variant.variant.id);
    expect(plan.plan.kind).toBe("x-article-draft");
    await expect(
      f.feature.service.prepareArticlePublish("owner", { id: randomUUID(), draftId: plan.plan.id }),
    ).rejects.toThrow("draftRequired");
    await f.submit(plan);
    await f.feature.idle();
    const draft = await f.feature.service.detail("owner", "x-article-draft", plan.plan.id);
    expect(draft.phase).toBe("completed");
    expect(draft.receipt).toMatchObject({ articleId: "301" });
    expect(draft.receipt).not.toHaveProperty("postId");
    const publish = await f.feature.service.prepareArticlePublish("owner", { id: randomUUID(), draftId: plan.plan.id });
    expect(publish.plan.kind).toBe("x-article-publish");
    expect(f.requests.map((request) => request.path)).toEqual(["/2/articles/draft"]);
    await f.submit(publish);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-article-publish", publish.plan.id)).receipt).toMatchObject({
      articleId: "301",
      postId: "401",
      url: "https://x.com/i/web/status/401",
    });
    expect(f.requests.map((request) => request.path)).toEqual(["/2/articles/draft", "/2/articles/301/publish"]);
    await expect(
      f.feature.service.prepareArticlePublish("someone", { id: randomUUID(), draftId: plan.plan.id }),
    ).rejects.toThrow("notFound");
  } finally {
    await f.dispose();
  }
});

test("content review, source freshness, account ownership and explicit cost confirmation all precede dispatch", async () => {
  const f = await fixture();
  try {
    const unreviewed = await f.variant("x-post", false);
    await expect(f.prepare(unreviewed.variant.id)).rejects.toThrow("reviewRequired");
    const variant = await f.variant("x-post"),
      plan = await f.prepare(variant.variant.id);
    await expect(
      f.feature.service.prepare("owner", {
        id: randomUUID(),
        variantId: variant.variant.id,
        connectionId: f.target.id,
        text: "unreviewed replacement",
      }),
    ).rejects.toThrow("invalidInput");
    await expect(
      f.feature.service.submit("owner", { id: plan.plan.id, kind: "x-post", fingerprint: plan.plan.fingerprint }),
    ).rejects.toThrow("publicationConfirmationRequired");
    await expect(
      f.feature.service.prepare("someone", {
        id: randomUUID(),
        variantId: variant.variant.id,
        connectionId: f.target.id,
      }),
    ).rejects.toThrow("notFound");
    f.documents.service.saveDocument(f.document.document.id, {
      revision: 1,
      title: "Changed",
      content: "New source",
      locale: "en",
    });
    await expect(f.submit(plan)).rejects.toThrow("staleSource");
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("unknown publication outcomes are retained for inspection and never resumed as a new send", async () => {
  const f = await fixture("Thread content. ".repeat(50));
  try {
    const plan = await f.prepare((await f.variant("x-thread")).variant.id);
    f.fail("unknown");
    await f.submit(plan);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).phase).toBe("needsAttention");
    await expect(f.submit(plan, true)).rejects.toThrow("conflict");
    expect((await f.prepare((plan.plan.payload as { source: { variantId: string } }).source.variantId)).plan.id).toBe(
      plan.plan.id,
    );
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

test("source media cannot be silently discarded and disconnecting an account invalidates queued publication", async () => {
  const withImage = await fixture("![Original](https://example.com/image.png)\n\nDescription.");
  try {
    const variant = await withImage.variant("x-post");
    await expect(withImage.prepare(variant.variant.id)).rejects.toThrow("mediaRequired");
    expect(withImage.requests).toHaveLength(0);
  } finally {
    await withImage.dispose();
  }
  const f = await fixture();
  try {
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    f.disable();
    await expect(f.submit(plan)).rejects.toThrow("authorizationChanged");
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("a confirmation write failure cannot queue a publication and a missing audit record prevents execution", async () => {
  const f = await fixture();
  try {
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    f.documents.persistence.exec(
      "CREATE TRIGGER fail_confirmation BEFORE INSERT ON publication_confirmations BEGIN SELECT RAISE(ABORT,'unavailable audit'); END;",
    );
    await expect(f.submit(plan)).rejects.toThrow("unavailable audit");
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).phase).toBe("prepared");
    expect(f.requests).toHaveLength(0);
    f.documents.persistence.exec("DROP TRIGGER fail_confirmation;");
    await expect(f.feature.service.authorizeExecution("owner", plan.plan)).rejects.toThrow(
      "publicationConfirmationRequired",
    );
    await f.submit(plan);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).confirmations).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});
