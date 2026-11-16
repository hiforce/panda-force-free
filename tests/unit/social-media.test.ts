import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { socialFixture } from "../support/social-publication-fixture.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import type { SocialPayload } from "../../src/shared/delivery/social.js";
import { socialAccounts } from "../../src/server/delivery/integration/social-accounts.js";

test("a provider's long processing delay cannot extend the workflow's bounded wait", async () => {
  let now = Date.now();
  const f = await socialFixture(undefined, {
    now: () => now,
    async respond() {
      return {
        data: { id: "101", expires_after_secs: 7200, processing_info: { state: "pending", check_after_secs: 3600 } },
      };
    },
  });
  try {
    await images(f);
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).nextRunAt).toBe(now + 30 * 60 * 1000);
    now += 30 * 60 * 1000 + 1;
    f.feature.wake();
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).error).toBe("mediaProcessingTimeout");
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

async function images(f: Awaited<ReturnType<typeof socialFixture>>, count = 1) {
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#ffaabb" } })
    .png()
    .toBuffer();
  const asset = await f.documents.assets.upload(f.document.document.id, "figure.png", bytes);
  f.save(
    "Reviewed illustration.\n\n" +
      Array.from(
        { length: count },
        (_, i) => `![Description ${i + 1}](/api/document-assets/content?id=${asset.id})`,
      ).join("\n\n"),
  );
  return { bytes, asset };
}

test("image capability is checked before publication and on refreshed token access without blocking text-only grants", async () => {
  let scopes = ["tweet.read", "tweet.write", "users.read"];
  const requested: string[][] = [];
  const accounts = {
    detail: () => ({
      enabled: true,
      projectId: "project",
      version: 1,
      account: { id: "123", username: "fixture" },
      grant: { scopes },
    }),
  } as unknown as Parameters<typeof socialAccounts>[0];
  const tokens = {
    async access(_owner: string, _id: string, _version: number, value: string[]) {
      requested.push(value);
      return { accessToken: "fixture", accountId: "123", guard() {} };
    },
  } as unknown as Parameters<typeof socialAccounts>[1];
  const bridge = socialAccounts(accounts, tokens),
    target = bridge.target("owner", "account");
  expect(() => bridge.assert("owner", target)).not.toThrow();
  expect(() => bridge.assert("owner", target, "media")).toThrow("authorizationRequired");
  await expect(bridge.access("owner", target, "media")).rejects.toThrow("authorizationRequired");
  expect(requested).toHaveLength(0);
  scopes = [...scopes, "media.write"];
  await bridge.access("owner", target, "media");
  expect(requested[0]).toContain("media.write");
});

test("resuming a partially published Thread skips confirmed posts even after their images expire", async () => {
  let now = Date.now(),
    uploads = 0,
    reject = true;
  const f = await socialFixture(undefined, {
    now: () => now,
    async respond(path, body) {
      if (path === "/2/media/upload") {
        uploads++;
        if (uploads === 5 && reject) throw new RemoteOperationError("rateLimited", "rejected");
        return { data: { id: String(uploads), expires_after_secs: 2 } };
      }
      if (path === "/2/media/metadata") return { data: { id: body!.id } };
      return { data: { id: String(100 + f.requests.length), text: "Confirmed" } };
    },
  });
  try {
    await images(f, 6);
    const plan = await f.prepare((await f.variant("x-thread")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).phase).toBe("failed");
    expect(f.requests.filter((request) => request.path === "/2/tweets")).toHaveLength(1);
    now += 3000;
    reject = false;
    await f.submit(plan, true);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).phase).toBe("completed");
    expect(uploads).toBe(7);
    const posts = f.requests.filter((request) => request.path === "/2/tweets");
    expect(posts).toHaveLength(2);
    expect((posts[0]!.body as { media: { media_ids: string[] } }).media.media_ids).toEqual(["1", "2", "3", "4"]);
    expect((posts[1]!.body as { media: { media_ids: string[] } }).media.media_ids).toEqual(["6", "7"]);
  } finally {
    await f.dispose();
  }
});

test("metadata rejection followed by expiration retains its audit trail when the replacement succeeds", async () => {
  let now = Date.now(),
    upload = 0,
    reject = true;
  const f = await socialFixture(undefined, {
    now: () => now,
    async respond(path, body) {
      if (path === "/2/media/upload") return { data: { id: String(++upload), expires_after_secs: 2 } };
      if (path === "/2/media/metadata") {
        if (reject) throw new RemoteOperationError("platformRejected", "rejected");
        return { data: { id: body!.id } };
      }
      return { data: { id: "201", text: "Confirmed" } };
    },
  });
  try {
    await images(f);
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    now += 3000;
    reject = false;
    await f.submit(plan, true);
    await f.feature.idle();
    const record = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(record.phase).toBe("completed");
    const rejected = record.steps.find((step) => step.outcome === "rejected");
    expect(rejected?.operation).toBe("media.metadata");
    expect(rejected?.replacedBy).toBeGreaterThan(rejected!.id);
  } finally {
    await f.dispose();
  }
});

test("reviewed Thread binds every image once to at most four per post; Article images remain separate from public publication", async () => {
  const f = await socialFixture(undefined, {
    async respond(path, body) {
      if (path === "/2/media/upload")
        return { data: { id: String(1000 + f.requests.length), expires_after_secs: 3600 } };
      if (path === "/2/media/metadata") return { data: { id: body!.id } };
      if (path === "/2/articles/draft") return { data: { id: "901", title: "Guide" } };
      if (path.endsWith("/publish")) return { data: { post_id: "902" } };
      return { data: { id: String(2000 + f.requests.length), text: "Confirmed" } };
    },
  });
  try {
    const { bytes } = await images(f, 6);
    const post = await f.variant("x-post", false);
    expect(post.variant.issues).toContainEqual({ code: "postImageLimit", severity: "blocking", blockId: "posts" });
    const variant = await f.variant("x-thread"),
      plan = await f.prepare(variant.variant.id);
    const payload = plan.plan.payload as unknown as SocialPayload;
    expect(payload.media).toHaveLength(6);
    if (payload.content.format === "x-article") throw Error("Wrong format");
    expect(payload.content.postMedia?.flat()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(payload.content.postMedia?.map((group) => group.length)).toEqual([4, 2]);
    await f.submit(plan);
    await f.feature.idle();
    const record = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(record.error).toBeNull();
    expect(record.phase).toBe("completed");
    const uploads = f.requests.filter((request) => request.path === "/2/media/upload");
    expect(uploads).toHaveLength(6);
    expect(uploads[0]?.body).toEqual({ media: bytes.toString("base64"), media_category: "tweet_image" });
    const posts = f.requests.filter((request) => request.path === "/2/tweets");
    expect(posts.map((request) => (request.body as { media: { media_ids: string[] } }).media.media_ids.length)).toEqual(
      [4, 2],
    );
    expect(JSON.stringify(record)).not.toContain(bytes.toString("base64"));
    const draftPlan = await f.prepare((await f.variant("x-article")).variant.id);
    await f.submit(draftPlan);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-article-draft", draftPlan.plan.id)).phase).toBe("completed");
    const article = f.requests.find((request) => request.path === "/2/articles/draft")?.body as {
      content_state: { entities: { value: { type: string } }[] };
    };
    expect(article.content_state.entities.filter((entity) => entity.value.type === "image")).toHaveLength(6);
    expect(JSON.stringify(article)).not.toContain("/api/document-assets");
    expect(f.requests.some((request) => request.path.endsWith("/publish"))).toBe(false);
    const publicPlan = await f.feature.service.prepareArticlePublish("owner", {
      id: randomUUID(),
      draftId: draftPlan.plan.id,
    });
    const before = f.requests.length;
    await f.submit(publicPlan);
    await f.feature.idle();
    expect(f.requests.slice(before).map((request) => request.path)).toEqual(["/2/articles/901/publish"]);
  } finally {
    await f.dispose();
  }
});

test("media processing releases the worker, survives restart, and queries status without another upload or confirmation", async () => {
  let now = Date.now();
  const f = await socialFixture(undefined, {
    now: () => now,
    async respond(path, body, method) {
      if (method === "GET")
        return { data: { id: "101", expires_after_secs: 3600, processing_info: { state: "succeeded" } } };
      if (path === "/2/media/upload")
        return {
          data: { id: "101", expires_after_secs: 3600, processing_info: { state: "pending", check_after_secs: 2 } },
        };
      if (path === "/2/media/metadata") return { data: { id: body!.id } };
      return { data: { id: "201", text: "Confirmed" } };
    },
  });
  try {
    await images(f);
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    const waiting = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(waiting.phase).toBe("waiting");
    expect(waiting.nextRunAt).toBe(now + 2000);
    expect(f.requests).toHaveLength(1);
    await f.restart();
    await f.feature.idle();
    expect(f.requests).toHaveLength(1);
    now += 3000;
    f.feature.wake();
    await f.feature.idle();
    const completed = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(completed.error).toBeNull();
    expect(completed.phase).toBe("completed");
    expect(completed.confirmations).toHaveLength(1);
    expect(completed.observations).toHaveLength(1);
    expect(f.requests.map((request) => request.path)).toEqual([
      "/2/media/upload",
      "/2/media/upload?media_id=101&command=STATUS",
      "/2/media/metadata",
      "/2/tweets",
    ]);
    expect(completed.steps.map((step) => step.operation)).toEqual(["media.upload", "media.metadata", "post.create"]);
  } finally {
    await f.dispose();
  }
});

test("expired images renew only on explicit resume and rejected post bindings are auditable across multiple resumes", async () => {
  let now = Date.now(),
    reject = true,
    upload = 0;
  const f = await socialFixture(undefined, {
    now: () => now,
    async respond(path, body) {
      if (path === "/2/media/upload") return { data: { id: String(++upload), expires_after_secs: 2 } };
      if (path === "/2/media/metadata") return { data: { id: body!.id } };
      if (reject) throw new RemoteOperationError("platformRejected", "rejected");
      return { data: { id: "201", text: "Confirmed" } };
    },
  });
  try {
    await images(f);
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).phase).toBe("failed");
    now += 3000;
    await f.restart();
    await f.feature.idle();
    expect(upload).toBe(1);
    await f.submit(plan, true);
    await f.feature.idle();
    expect(upload).toBe(2);
    expect((await f.feature.service.detail("owner", "x-post", plan.plan.id)).phase).toBe("failed");
    now += 3000;
    reject = false;
    await f.submit(plan, true);
    await f.feature.idle();
    const completed = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(completed.error).toBeNull();
    expect(completed.phase).toBe("completed");
    expect(upload).toBe(3);
    expect(
      completed.steps.filter((step) => step.outcome === "rejected").every((step) => step.replacedBy !== null),
    ).toBe(true);
    expect(
      f.requests
        .filter((request) => request.path === "/2/tweets")
        .map((request) => (request.body as { media: { media_ids: string[] } }).media.media_ids),
    ).toEqual([["1"], ["2"], ["3"]]);
    const count = f.requests.length;
    await f.submit(plan, true);
    await f.feature.idle();
    expect(f.requests).toHaveLength(count);
  } finally {
    await f.dispose();
  }
});

test("an unknown image upload outcome is never hidden by polling, renewed, or turned into a public post", async () => {
  const f = await socialFixture(undefined, {
    async respond() {
      throw new RemoteOperationError("platformUnavailable", "unknown");
    },
  });
  try {
    await images(f);
    const plan = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(plan);
    await f.feature.idle();
    const record = await f.feature.service.detail("owner", "x-post", plan.plan.id);
    expect(record.phase).toBe("needsAttention");
    expect(record.steps[0]?.outcome).toBe("pending");
    expect(record.observations).toHaveLength(0);
    expect(record.nextRunAt).toBeNull();
    await expect(f.submit(plan, true)).rejects.toThrow("conflict");
    await f.restart();
    await f.feature.idle();
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test("missing expiry and rejected image processing stop before metadata or public mutation", async () => {
  for (const state of ["succeeded", "failed"]) {
    const f = await socialFixture(undefined, {
      async respond() {
        return { data: { id: "101", processing_info: { state } } };
      },
    });
    try {
      await images(f);
      const plan = await f.prepare((await f.variant("x-post")).variant.id);
      await f.submit(plan);
      await f.feature.idle();
      const record = await f.feature.service.detail("owner", "x-post", plan.plan.id);
      expect(record.phase).toBe("failed");
      expect(record.error).toBe(state === "failed" ? "mediaProcessingFailed" : "mediaExpiryUnavailable");
      expect(f.requests.some((request) => request.path === "/2/tweets" || request.path === "/2/media/metadata")).toBe(
        false,
      );
    } finally {
      await f.dispose();
    }
  }
});

test("status transport failures use bounded read-only retries; authorization failures do not retry", async () => {
  for (const code of ["platformUnavailable", "platformPermissionDenied"]) {
    let now = Date.now();
    const f = await socialFixture(undefined, {
      now: () => now,
      async respond(_path, _body, method) {
        if (method === "GET")
          throw new RemoteOperationError(code, code === "platformUnavailable" ? "unknown" : "rejected");
        return {
          data: { id: "101", expires_after_secs: 3600, processing_info: { state: "pending", check_after_secs: 1 } },
        };
      },
    });
    try {
      await images(f);
      const plan = await f.prepare((await f.variant("x-post")).variant.id);
      await f.submit(plan);
      await f.feature.idle();
      for (let i = 0; i < 7; i++) {
        now += 61000;
        f.feature.wake();
        await f.feature.idle();
      }
      const record = await f.feature.service.detail("owner", "x-post", plan.plan.id);
      expect(record.phase).toBe("failed");
      expect(record.error).toBe(code);
      expect(record.steps).toHaveLength(1);
      expect(record.steps[0]?.outcome).toBe("succeeded");
      expect(f.requests.filter((request) => request.path.includes("command=STATUS"))).toHaveLength(
        code === "platformUnavailable" ? 6 : 1,
      );
    } finally {
      await f.dispose();
    }
  }
});
