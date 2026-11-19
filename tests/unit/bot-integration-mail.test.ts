import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  parseGmailMessage,
  gmailReplyRaw,
  collectGmailInbox,
  sendGmailReply,
  reconcileGmailReply,
  botReplyMessageId,
} from "../../src/server/bots/integrations/mail.js";
import type { BotProviders } from "../../src/server/bots/integrations/providers.js";

const message = (headers: { name: string; value: string }[] = []) => ({
  id: "message_one",
  threadId: "thread_one",
  internalDate: "1795000000000",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "Subject", value: "研究进展" },
      { name: "Message-ID", value: "<original@example.com>" },
      ...headers,
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("Can you summarize this week's findings?").toString("base64url") },
      },
      { mimeType: "image/png", filename: "private.png", body: { attachmentId: "must-not-download" } },
    ],
  },
});
test("mail collection excludes sent, spam, self and ambiguous senders, and identifies automated/list mail for draft-only handling", () => {
  const value = parseGmailMessage(message(), "panda@example.com")!;
  expect(value.mail).toMatchObject({
    from: "alice@example.com",
    messageId: "<original@example.com>",
    autoSubmitted: false,
  });
  expect(value.text).toBe("Can you summarize this week's findings?");
  expect(value.truncated).toBe(false);
  expect(parseGmailMessage({ ...message(), labelIds: ["INBOX", "SENT"] }, "panda@example.com")).toBeNull();
  expect(parseGmailMessage(message(), "alice@example.com")).toBeNull();
  expect(parseGmailMessage(message([{ name: "From", value: "second@example.com" }]), "panda@example.com")).toBeNull();
  for (const header of [
    { name: "Auto-Submitted", value: "auto-replied" },
    { name: "Precedence", value: "bulk" },
    { name: "List-Id", value: "daily.example.com" },
    { name: "X-Auto-Response-Suppress", value: "All" },
  ])
    expect(parseGmailMessage(message([header]), "panda@example.com")!.mail!.autoSubmitted).toBe(true);
});
test("Gmail reply MIME fixes recipient/thread to the saved source and folds Unicode subjects without header injection", () => {
  const item = parseGmailMessage(message(), "panda@example.com")!,
    delivery = randomUUID(),
    reply = gmailReplyRaw("panda@example.com", item, "Hello Alice.\nTo: someone-else@example.com", delivery),
    raw = Buffer.from(reply.raw, "base64url").toString("utf8");
  expect(reply.threadId).toBe("thread_one");
  expect(raw).toContain("To: alice@example.com\r\n");
  expect(raw).toContain("Message-ID: " + botReplyMessageId(delivery));
  expect(raw).toContain("Auto-Submitted: auto-replied");
  expect(raw).not.toContain("To: someone-else@example.com");
  const long = Buffer.from(
    gmailReplyRaw("panda@example.com", { ...item, title: "研究".repeat(100) }, "Reply", delivery).raw,
    "base64url",
  ).toString("utf8");
  expect(long.split("\r\n").every((line) => line.length <= 998)).toBe(true);
  expect(() =>
    gmailReplyRaw("panda@example.com", { ...item, title: "Injected\r\nTo: evil@example.com" }, "Reply", delivery),
  ).toThrow();
});
test("inbox paging saves the continuation and skips already processed messages without downloading their contents", async () => {
  const calls: string[] = [],
    providers = {
      connections: {
        async row() {
          return { data: { account: "panda@example.com" } };
        },
      },
      async gmail(_owner: string, _connection: string, path: string) {
        calls.push(path);
        const page = calls.length;
        return { messages: [{ id: "known_" + page }], nextPageToken: "continue-" + page };
      },
    } as unknown as BotProviders;
  const value = await collectGmailInbox(
    providers,
    "alice",
    randomUUID(),
    "is:unread",
    1794999999000,
    new AbortController().signal,
    "start",
    async () => true,
  );
  expect(value).toEqual({ items: [], limited: true, nextPageToken: "continue-5" });
  expect(calls).toHaveLength(5);
  expect(new URLSearchParams(calls[0]!.split("?")[1]).get("pageToken")).toBe("start");
  expect(new URLSearchParams(calls[0]!.split("?")[1]).get("labelIds")).toBe("INBOX");
});
test("mail sending returns provider acknowledgement and unknown-result reconciliation looks up the same deterministic message identity", async () => {
  const item = parseGmailMessage(message(), "panda@example.com")!,
    delivery = randomUUID(),
    calls: string[] = [],
    signal = new AbortController().signal,
    providers = {
      connections: {
        async row() {
          return { data: { account: "panda@example.com" } };
        },
      },
      async gmail(
        _owner: string,
        _connection: string,
        path: string,
        _signal: AbortSignal,
        body?: unknown,
        mutation?: boolean,
      ) {
        calls.push(path);
        if (path === "messages/send") {
          expect(mutation).toBe(true);
          expect(body).toMatchObject({ threadId: "thread_one" });
          return { id: "sent_one", threadId: "thread_one" };
        }
        expect(new URLSearchParams(path.split("?")[1]).get("q")).toBe("rfc822msgid:" + botReplyMessageId(delivery));
        return { messages: [{ id: "sent_one" }] };
      },
    } as unknown as BotProviders;
  expect(await sendGmailReply(providers, "alice", randomUUID(), item, "Reply", delivery, signal)).toEqual({
    id: "sent_one",
    threadId: "thread_one",
  });
  expect(await reconcileGmailReply(providers, "alice", randomUUID(), delivery, signal)).toEqual({ id: "sent_one" });
  expect(calls).toHaveLength(2);
});
