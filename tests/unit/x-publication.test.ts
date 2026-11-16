import { expect, test } from "bun:test";
import { XPublicationClient } from "../../src/server/delivery/adapters/x/client.js";
import { XPublicationHttp } from "../../src/server/delivery/adapters/x/http.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import type { XAccess } from "../../src/server/delivery/adapters/x/http.js";

const access: XAccess = { accessToken: "fixture-access", accountId: "123", guard() {} };
const draft = {
  title: "Fixture article",
  content_state: { blocks: [{ key: "one", type: "unstyled" as const, text: "Reviewed content" }], entities: [] },
};
const fakeFetch = (send: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  send as typeof fetch;

test("Post, thread replies, Article draft and Article publish use distinct official endpoints and receipts", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new XPublicationClient(
    new XPublicationHttp(
      fakeFetch(async (url, init) => {
        requests.push({ url: String(url), init: init! });
        if (String(url).endsWith("/draft")) return Response.json({ data: { id: "301", title: draft.title } });
        if (String(url).endsWith("/publish")) return Response.json({ data: { post_id: "401" } });
        return Response.json({ data: { id: requests.length === 1 ? "201" : "202", text: "Created post" } });
      }),
    ),
    () => 1000,
  );
  const first = await client.post(access, { text: "First part" });
  const second = await client.post(access, {
    text: "Second part",
    replyTo: first.postId,
    mediaIds: ["501"],
    madeWithAi: true,
  });
  expect(first).toEqual({ postId: "201", url: "https://x.com/i/web/status/201", accountId: "123", receivedAt: 1000 });
  expect(second.postId).toBe("202");
  const article = await client.draft(access, draft);
  expect(article).toEqual({ articleId: "301", accountId: "123", receivedAt: 1000 });
  expect(article).not.toHaveProperty("postId");
  expect(article).not.toHaveProperty("url");
  const published = await client.publishArticle(access, article.articleId);
  expect(published).toEqual({
    articleId: "301",
    postId: "401",
    url: "https://x.com/i/web/status/401",
    accountId: "123",
    receivedAt: 1000,
  });
  expect(requests.map(({ url }) => url)).toEqual([
    "https://api.x.com/2/tweets",
    "https://api.x.com/2/tweets",
    "https://api.x.com/2/articles/draft",
    "https://api.x.com/2/articles/301/publish",
  ]);
  expect(JSON.parse(requests[1]!.init.body as string)).toEqual({
    text: "Second part",
    reply: { in_reply_to_tweet_id: "201" },
    media: { media_ids: ["501"] },
    made_with_ai: true,
  });
  expect(JSON.parse(requests[2]!.init.body as string)).toEqual(draft);
  expect(requests[3]!.init.body).toBeUndefined();
  for (const request of requests) {
    expect(request.init.method).toBe("POST");
    expect(request.init.redirect).toBe("error");
    expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer fixture-access");
  }
});

test("publication HTTP distinguishes definitive rejections from unknown outcomes without retry or raw errors", async () => {
  for (const [status, outcome, code] of [
    [400, "rejected", "platformRejected"],
    [401, "rejected", "platformPermissionDenied"],
    [402, "rejected", "platformPaymentRequired"],
    [403, "rejected", "platformPermissionDenied"],
    [429, "rejected", "rateLimited"],
    [408, "unknown", "platformUnavailable"],
    [500, "unknown", "platformUnavailable"],
    [302, "unknown", "platformUnavailable"],
  ] as const) {
    let sends = 0;
    const client = new XPublicationClient(
      new XPublicationHttp(
        fakeFetch(async () => {
          sends++;
          return new Response("private provider error", { status });
        }),
      ),
    );
    let failure: unknown;
    try {
      await client.post(access, { text: "Fixture" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RemoteOperationError);
    expect((failure as RemoteOperationError).outcome).toBe(outcome);
    expect((failure as RemoteOperationError).code).toBe(code);
    expect(String(failure)).not.toContain("private");
    expect(sends).toBe(1);
  }
});

test("successful but malformed responses are never treated as safely retryable or public receipts", async () => {
  for (const body of [
    {},
    { data: { id: "bad/id", text: "Fixture" } },
    { data: { id: "123" } },
    { data: { id: 123, text: "Fixture" } },
  ]) {
    const client = new XPublicationClient(new XPublicationHttp(fakeFetch(async () => Response.json(body))));
    await expect(client.post(access, { text: "Fixture" })).rejects.toMatchObject({
      outcome: "unknown",
      code: "invalidPlatformResponse",
    });
  }
  const client = new XPublicationClient(
    new XPublicationHttp(fakeFetch(async () => Response.json({ data: { id: "123", title: "Fixture article" } }))),
  );
  await expect(client.publishArticle(access, "123")).rejects.toMatchObject({ outcome: "unknown" });
});

test("invalid content, identifiers, token headers and revoked access never dispatch network requests", async () => {
  let sends = 0;
  const http = new XPublicationHttp(
    fakeFetch(async () => {
      sends++;
      return Response.json({});
    }),
  );
  const client = new XPublicationClient(http);
  await expect(client.post(access, { text: "x".repeat(281) })).rejects.toMatchObject({ outcome: "rejected" });
  await expect(client.post(access, { text: "Fixture", replyTo: "../../other" })).rejects.toMatchObject({
    outcome: "rejected",
  });
  await expect(client.post(access, { text: "Fixture", mediaIds: ["1", "2", "3", "4", "5"] })).rejects.toMatchObject({
    outcome: "rejected",
  });
  await expect(client.publishArticle(access, "../bad")).rejects.toMatchObject({ outcome: "rejected" });
  await expect(http.request("https://example.com/steal", access)).rejects.toMatchObject({ outcome: "rejected" });
  await expect(client.post({ ...access, accessToken: "bad\nheader" }, { text: "Fixture" })).rejects.toMatchObject({
    outcome: "rejected",
  });
  await expect(
    client.post(
      {
        ...access,
        guard() {
          throw new Error("disconnected");
        },
      },
      { text: "Fixture" },
    ),
  ).rejects.toMatchObject({ outcome: "rejected", code: "authorizationChanged" });
  expect(sends).toBe(0);
});

test("publication responses are bounded and timeouts never cause automatic retries", async () => {
  const oversized = new XPublicationHttp(fakeFetch(async () => Response.json({ data: "x".repeat(128 * 1024) })));
  await expect(oversized.request("/2/tweets", access, "{}")).rejects.toMatchObject({
    outcome: "unknown",
    code: "invalidPlatformResponse",
  });
  let calls = 0;
  const timeout = new XPublicationHttp(
    fakeFetch(async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("private timeout")), { once: true }),
      );
    }),
    10,
  );
  await expect(timeout.request("/2/tweets", access, "{}")).rejects.toMatchObject({
    outcome: "unknown",
    code: "platformUnavailable",
  });
  expect(calls).toBe(1);
});
