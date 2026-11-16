import { expect, test } from "bun:test";
import { socialFixture } from "../support/social-publication-fixture.js";
import { RemoteOperationError } from "../../src/server/delivery/workflows/errors.js";
import type { WorkflowRecord } from "../../src/shared/delivery/workflow.js";
import { XPublicationHttp } from "../../src/server/delivery/adapters/x/http.js";
import { X_POST_LOOKUP_FIELDS } from "../../src/server/delivery/adapters/x/lookup-fields.js";
import { XRecoveryClient } from "../../src/server/delivery/adapters/x/recovery-client.js";
import sharp from "sharp";

const binding = (record: WorkflowRecord) => ({
  id: record.plan.id,
  kind: record.plan.kind,
  fingerprint: record.plan.fingerprint,
});
test("a lost Thread response is reconciled read-only, adopted explicitly and resumed without duplicating the first Post", async () => {
  let writes = 0,
    firstText = "";
  const f = await socialFixture(
    "A carefully reviewed implementation with durable receipts and restart safety. ".repeat(18),
    {
      async respond(path, body, method) {
        if (method === "GET") {
          expect(path).toBe(`/2/tweets/201?tweet.fields=${X_POST_LOOKUP_FIELDS}`);
          return { data: { id: "201", text: firstText, author_id: "123", created_at: new Date().toISOString() } };
        }
        writes++;
        if (writes === 1) {
          firstText = String(body!.text);
          throw new RemoteOperationError("platformUnavailable", "unknown");
        }
        return { data: { id: String(200 + writes), text: body!.text } };
      },
    },
  );
  try {
    const draft = await f.prepare((await f.variant("x-thread")).variant.id);
    await f.submit(draft);
    await f.feature.idle();
    const original = await f.feature.service.detail("owner", "x-post", draft.plan.id),
      step = original.steps[0]!;
    expect(original.phase).toBe("needsAttention");
    const evidence = await f.feature.recovery.inspect("owner", {
      ...binding(draft),
      stepId: step.id,
      remoteId: "201",
      acceptLookupCosts: true,
    });
    expect(evidence.status).toBe("match");
    expect(writes).toBe(1);
    await expect(f.feature.recovery.adopt("owner", { ...binding(draft), evidenceId: evidence.id })).rejects.toThrow(
      "invalidInput",
    );
    const resolved = await f.feature.recovery.adopt("owner", {
      ...binding(draft),
      evidenceId: evidence.id,
      acceptExistingResult: true,
    });
    expect(resolved.steps).toEqual(original.steps);
    expect(resolved.phase).toBe("failed");
    await f.restart();
    await f.feature.idle();
    expect(writes).toBe(1);
    await f.submit(resolved, true);
    await f.feature.idle();
    const complete = await f.feature.service.detail("owner", "x-post", draft.plan.id);
    expect(complete.phase).toBe("completed");
    expect(complete.resolutions).toHaveLength(1);
    expect(complete.steps[0]?.outcome).toBe("pending");
    expect(writes).toBe((draft.plan.payload as { content: { posts: string[] } }).content.posts.length);
    const second = f.requests.filter((item) => item.path === "/2/tweets")[1]!.body as { reply: unknown };
    expect(second.reply).toEqual({ in_reply_to_tweet_id: "201" });
  } finally {
    await f.dispose();
  }
});

test("wrong author, text, reply, media, age and lookup failures never release an unknown Post", async () => {
  let observed: Record<string, unknown> = {},
    error = false,
    text = "";
  const f = await socialFixture("Review my post.", {
    async respond(_path, body, method) {
      if (method !== "GET") {
        text = String(body!.text);
        throw new RemoteOperationError("platformUnavailable", "unknown");
      }
      if (error) throw new RemoteOperationError("platformRejected", "rejected");
      return { data: { id: "201", author_id: "123", text, created_at: new Date().toISOString(), ...observed } };
    },
  });
  try {
    const record = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(record);
    await f.feature.idle();
    const step = (await f.feature.service.detail("owner", "x-post", record.plan.id)).steps[0]!;
    for (const change of [
      { author_id: "456" },
      { text: "Different" },
      { referenced_tweets: [{ type: "replied_to", id: "999" }] },
      { attachments: { media_keys: ["3_501"] } },
      { created_at: "2001-01-01T00:00:00Z" },
    ]) {
      observed = change;
      const evidence = await f.feature.recovery.inspect("owner", {
        ...binding(record),
        stepId: step.id,
        remoteId: "201",
        acceptLookupCosts: true,
      });
      expect(evidence.status).toBe("mismatch");
      await expect(
        f.feature.recovery.adopt("owner", { ...binding(record), evidenceId: evidence.id, acceptExistingResult: true }),
      ).rejects.toThrow("recoveryNotMatched");
    }
    error = true;
    const unavailable = await f.feature.recovery.inspect("owner", {
      ...binding(record),
      stepId: step.id,
      remoteId: "201",
      acceptLookupCosts: true,
    });
    expect(unavailable.status).toBe("unavailable");
    expect((await f.feature.service.detail("owner", "x-post", record.plan.id)).phase).toBe("needsAttention");
  } finally {
    await f.dispose();
  }
});

test("an account change during lookup rejects stale evidence; an Article unknown has no invented read endpoint", async () => {
  let hook = () => {};
  const f = await socialFixture("Review my post.", {
    async respond(_path, _body, method) {
      if (method === "GET") hook();
      throw new RemoteOperationError("platformUnavailable", "unknown");
    },
  });
  try {
    const record = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(record);
    await f.feature.idle();
    const step = (await f.feature.service.detail("owner", "x-post", record.plan.id)).steps[0]!;
    hook = () => {
      f.target.version++;
    };
    await expect(
      f.feature.recovery.inspect("owner", {
        ...binding(record),
        stepId: step.id,
        remoteId: "201",
        acceptLookupCosts: true,
      }),
    ).rejects.toThrow("authorizationChanged");
    expect((await f.feature.service.detail("owner", "x-post", record.plan.id)).recoveryEvidence).toEqual([]);
    const article = await f.prepare((await f.variant("x-article")).variant.id);
    await f.submit(article);
    await f.feature.idle();
    const draftStep = (await f.feature.service.detail("owner", "x-article-draft", article.plan.id)).steps[0]!;
    const count = f.requests.length;
    await expect(
      f.feature.recovery.inspect("owner", {
        ...binding(article),
        stepId: draftStep.id,
        remoteId: "201",
        acceptLookupCosts: true,
      }),
    ).rejects.toThrow("recoveryUnsupported");
    expect(f.requests).toHaveLength(count);
  } finally {
    await f.dispose();
  }
});

test("lookup transport is fixed-origin, read-only and rejects arbitrary query parameters or URLs", async () => {
  let calls = 0;
  const http = new XPublicationHttp((async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe(`https://api.x.com/2/tweets/123?tweet.fields=${X_POST_LOOKUP_FIELDS}`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
    return Response.json({ data: {} });
  }) as typeof fetch);
  const access = { accountId: "123", accessToken: "fixture", guard() {} },
    path = `/2/tweets/123?tweet.fields=${X_POST_LOOKUP_FIELDS}`;
  await http.request(path, access, undefined, "GET");
  for (const input of [
    path + "&token=foo",
    "https://example.com/" + path,
    path.replace("123", "../123"),
    path.replace("tweet.fields", "tweetXfields"),
  ])
    await expect(http.request(input, access, undefined, "GET")).rejects.toThrow("invalidInput");
  await expect(http.request(path, access, "{}", "GET")).rejects.toThrow("invalidInput");
  expect(calls).toBe(1);
});

test("recovery compares exact provider media keys and refuses to infer missing keys from old receipts", async () => {
  for (const includeKey of [true, false]) {
    let text = "",
      remoteKey = "3_999";
    const f = await socialFixture(undefined, {
      async respond(path, body, method) {
        if (method === "GET")
          return {
            data: {
              id: "201",
              author_id: "123",
              text,
              created_at: new Date().toISOString(),
              attachments: { media_keys: [remoteKey] },
            },
          };
        if (path === "/2/media/upload")
          return { data: { id: "501", expires_after_secs: 3600, ...(includeKey ? { media_key: "3_501" } : {}) } };
        if (path === "/2/media/metadata") return { data: { id: body!.id } };
        text = String(body!.text);
        throw new RemoteOperationError("platformUnavailable", "unknown");
      },
    });
    try {
      const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } })
        .png()
        .toBuffer();
      const asset = await f.documents.assets.upload(f.document.document.id, "image.png", bytes);
      f.save(`A reviewed image.\n\n![Description](/api/document-assets/content?id=${asset.id})`);
      const record = await f.prepare((await f.variant("x-post")).variant.id);
      await f.submit(record);
      await f.feature.idle();
      const current = await f.feature.service.detail("owner", "x-post", record.plan.id),
        step = current.steps.at(-1)!;
      expect(step.outcome).toBe("pending");
      const input = { ...binding(record), stepId: step.id, remoteId: "201", acceptLookupCosts: true };
      if (!includeKey) {
        const count = f.requests.length;
        await expect(f.feature.recovery.inspect("owner", input)).rejects.toThrow("recoveryMediaUnavailable");
        expect(f.requests).toHaveLength(count);
        continue;
      }
      expect((await f.feature.recovery.inspect("owner", input)).status).toBe("mismatch");
      remoteKey = "3_501";
      const evidence = await f.feature.recovery.inspect("owner", input);
      expect(evidence.status).toBe("match");
      const adopted = await f.feature.recovery.adopt("owner", {
        ...binding(record),
        evidenceId: evidence.id,
        acceptExistingResult: true,
      });
      const calls = f.requests.length;
      await f.submit(adopted, true);
      await f.feature.idle();
      expect((await f.feature.service.detail("owner", "x-post", record.plan.id)).phase).toBe("completed");
      expect(f.requests).toHaveLength(calls);
    } finally {
      await f.dispose();
    }
  }
});

test("URL entities expand only at verified offsets, preserve Unicode and never accept arbitrary text changes", async () => {
  let sent = "",
    response: Record<string, unknown> = {};
  const f = await socialFixture("🐼 Visit https://example.com/guide", {
    async respond(_path, body, method) {
      if (method === "GET")
        return { data: { id: "201", author_id: "123", created_at: new Date().toISOString(), ...response } };
      sent = String(body!.text);
      throw new RemoteOperationError("platformUnavailable", "unknown");
    },
  });
  try {
    const record = await f.prepare((await f.variant("x-post")).variant.id);
    await f.submit(record);
    await f.feature.idle();
    const current = await f.feature.service.detail("owner", "x-post", record.plan.id),
      step = current.steps[0]!;
    const input = { ...binding(record), stepId: step.id, remoteId: "201", acceptLookupCosts: true },
      short = "https://t.co/abc",
      expanded = "https://example.com/guide",
      text = sent.replace(expanded, short);
    for (const chars of [text.split(""), Array.from(text)]) {
      const start = chars.join("").slice(0, text.indexOf(short));
      const offset = chars.length === text.length ? start.length : Array.from(start).length;
      response = {
        text,
        entities: { urls: [{ start: offset, end: offset + short.length, url: short, expanded_url: expanded }] },
      };
      expect((await f.feature.recovery.inspect("owner", input)).status).toBe("match");
    }
    response = { text, entities: { urls: [{ start: 0, end: short.length, url: short, expanded_url: expanded }] } };
    expect((await f.feature.recovery.inspect("owner", input)).status).toBe("mismatch");
    response = { text: sent + " Extra text" };
    expect((await f.feature.recovery.inspect("owner", input)).status).toBe("mismatch");
    const client = new XRecoveryClient({
      request: async () => {
        throw Error("must not read");
      },
    });
    const tampered = structuredClone(current);
    tampered.steps[0]!.requestHash = "0".repeat(64);
    expect(() => client.validate(tampered, step.id)).toThrow("invalidSnapshot");
  } finally {
    await f.dispose();
  }
});
