import { expect, test } from "bun:test";
import { XMediaClient, X_IMAGE_MAX_BYTES } from "../../src/server/delivery/adapters/x/media-client.js";
import { XPublicationHttp, type XAccess } from "../../src/server/delivery/adapters/x/http.js";

const access: XAccess = { accessToken: "fixture-token", accountId: "101", guard() {} };
const fakeFetch = (fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) => fn as typeof fetch;

test("X image upload and alt metadata use the documented schema without publishing content", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let now = 1000;
  const client = new XMediaClient(
    new XPublicationHttp(
      fakeFetch(async (url, init) => {
        calls.push({ url: String(url), init: init! });
        now = 2000;
        return Response.json({
          data: String(url).endsWith("/metadata") ? { id: "501" } : { id: "501", expires_after_secs: 60 },
        });
      }),
    ),
    () => now,
  );
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const receipt = await client.upload(access, bytes, "image/png");
  expect(receipt).toEqual({
    mediaId: "501",
    accountId: "101",
    category: "tweet_image",
    state: "succeeded",
    expiresAt: 61000,
    checkAt: null,
    progress: null,
    observedAt: 2000,
  });
  expect(receipt).not.toHaveProperty("postId");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ media: "AQIDBA==", media_category: "tweet_image" });
  await client.metadata(access, "501", "A panda at sunset 🐼");
  expect(calls.map((c) => c.url)).toEqual(["https://api.x.com/2/media/upload", "https://api.x.com/2/media/metadata"]);
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
    id: "501",
    metadata: { alt_text: { text: "A panda at sunset 🐼" } },
  });
  expect(calls.every((c) => c.init.method === "POST" && c.init.redirect === "error")).toBe(true);
});

test("media processing is polled read-only and observations never extend upload expiration", async () => {
  let now = 1000;
  const calls: RequestInit[] = [];
  const client = new XMediaClient(
    new XPublicationHttp(
      fakeFetch(async (url, init) => {
        calls.push(init!);
        if (init!.method === "GET") {
          expect(String(url)).toBe("https://api.x.com/2/media/upload?media_id=501&command=STATUS");
          expect(init!.body).toBeUndefined();
          return Response.json({
            data: {
              id: "501",
              expires_after_secs: 100,
              processing_info: { state: "succeeded", progress_percent: 100 },
            },
          });
        }
        return Response.json({
          data: {
            id: "501",
            expires_after_secs: 60,
            processing_info: { state: "in_progress", check_after_secs: 4, progress_percent: 20 },
          },
        });
      }),
    ),
    () => now,
  );
  const uploaded = await client.upload(access, Uint8Array.of(1), "image/webp");
  expect(uploaded.checkAt).toBe(5000);
  expect(uploaded.state).toBe("in_progress");
  now = 5000;
  const ready = await client.status(access, uploaded);
  expect(ready.expiresAt).toBe(61000);
  expect(ready.state).toBe("succeeded");
  expect(ready.progress).toBe(100);
  expect(ready.checkAt).toBeNull();
  expect(calls).toHaveLength(2);
});

test("media responses preserve unknown expiration and known processing failure without fabricating success", async () => {
  const client = new XMediaClient(
    { request: async () => ({ data: { id: "501", processing_info: { state: "failed" } } }) },
    () => 1000,
  );
  const failed = await client.upload(access, Uint8Array.of(1), "image/jpeg");
  expect(failed.expiresAt).toBeNull();
  expect(failed.state).toBe("failed");
  expect(failed.checkAt).toBeNull();
  for (const data of [
    { id: 501 },
    { id: "../../asset" },
    { id: "501", expires_after_secs: 0 },
    { id: "501", processing_info: { state: "unknown" } },
    { id: "501", processing_info: { state: "pending", check_after_secs: 4000 } },
    { id: "501", processing_info: { state: "in_progress", progress_percent: 110 } },
  ]) {
    const bad = new XMediaClient({ request: async () => ({ data }) });
    await expect(bad.upload(access, Uint8Array.of(1), "image/png")).rejects.toMatchObject({
      code: "invalidPlatformResponse",
      outcome: "unknown",
    });
  }
  const partial = new XMediaClient({
    request: async () => ({ data: { id: "501" }, errors: [{ private: "provider details" }] }),
  });
  await expect(partial.upload(access, Uint8Array.of(1), "image/png")).rejects.toMatchObject({
    code: "invalidPlatformResponse",
    outcome: "unknown",
  });
});

test("media validation and account binding reject input before dispatch", async () => {
  let requests = 0;
  const client = new XMediaClient({
    request: async () => {
      requests++;
      return { data: { id: "501", expires_after_secs: 60 } };
    },
  });
  for (const [bytes, mime] of [
    [new Uint8Array(), "image/png"],
    [new Uint8Array(X_IMAGE_MAX_BYTES + 1), "image/png"],
    [Uint8Array.of(1), "image/svg+xml"],
  ] as const)
    await expect(client.upload(access, bytes, mime)).rejects.toMatchObject({ outcome: "rejected" });
  await expect(client.metadata(access, "501", "a".repeat(1001))).rejects.toMatchObject({ outcome: "rejected" });
  const receipt = {
    mediaId: "501",
    accountId: "different",
    category: "tweet_image" as const,
    state: "succeeded" as const,
    expiresAt: null,
    checkAt: null,
    progress: null,
    observedAt: 0,
  };
  await expect(client.status(access, receipt)).rejects.toMatchObject({ outcome: "rejected" });
  expect(requests).toBe(0);
  await client.metadata(access, "501", "🐼".repeat(1000));
  expect(requests).toBe(1);
});

test("media status and metadata cannot acknowledge a different asset", async () => {
  const client = new XMediaClient({ request: async () => ({ data: { id: "502", expires_after_secs: 60 } }) });
  await expect(client.metadata(access, "501", "Alt")).rejects.toMatchObject({ outcome: "unknown" });
  await expect(
    client.status(access, {
      mediaId: "501",
      accountId: "101",
      category: "tweet_image",
      state: "pending",
      expiresAt: 1000,
      checkAt: 10,
      progress: null,
      observedAt: 0,
    }),
  ).rejects.toMatchObject({ outcome: "unknown" });
});

test("media transport permits only the fixed status query and bounded single-dispatch requests", async () => {
  let sends = 0;
  const http = new XPublicationHttp(
    fakeFetch(async () => {
      sends++;
      return Response.json({ data: { id: "501" } });
    }),
  );
  for (const path of [
    "/2/tweets",
    "/2/media/upload?media_id=501&other=1",
    "/2/media/upload?media_id=501&command=STATUS&redirect=https://example.com",
  ])
    await expect(http.request(path, access, undefined, "GET")).rejects.toMatchObject({ outcome: "rejected" });
  await expect(http.request("/2/media/upload?media_id=501&command=STATUS", access, "{}", "GET")).rejects.toMatchObject({
    outcome: "rejected",
  });
  await expect(http.request("/2/media/upload", access, "x".repeat(7 * 1024 * 1024 + 1))).rejects.toMatchObject({
    outcome: "rejected",
  });
  expect(sends).toBe(0);
  await http.request("/2/media/upload?media_id=501&command=STATUS", access, undefined, "GET");
  expect(sends).toBe(1);
});
