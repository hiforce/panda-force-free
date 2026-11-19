import { createHash } from "node:crypto";
import { isRecord } from "../../../shared/records.js";
import { BotError } from "../../../shared/bots/contracts.js";
import type { BotSourceItem } from "../../../shared/bots/integrations.js";
import { botFeedText } from "./feed.js";
import { BotProviders, BotProviderError, botMailAddress } from "./providers.js";

const gmailId = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : "");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function mailSender(value: string) {
  const bracket = /<([^<>]+)>\s*$/.exec(value.trim());
  try {
    return botMailAddress(bracket?.[1] ?? value.trim());
  } catch {
    return "";
  }
}
function mailText(payload: Record<string, unknown>, snippet: string): { text: string; truncated: boolean } {
  const pending = [{ part: payload, depth: 0 }],
    plain: string[] = [],
    html: string[] = [];
  let nodes = 0,
    size = 0,
    truncated = false;
  while (pending.length && nodes++ < 100) {
    const { part, depth } = pending.pop()!;
    if (depth > 8) {
      truncated = true;
      continue;
    }
    if (Array.isArray(part.parts))
      for (const child of part.parts.slice(0, 50).reverse())
        if (isRecord(child)) pending.push({ part: child, depth: depth + 1 });
    if (
      !["text/plain", "text/html"].includes(String(part.mimeType)) ||
      !isRecord(part.body) ||
      typeof part.body.data !== "string" ||
      part.filename
    )
      continue;
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(part.body.data) || part.body.data.length > 128000) {
      truncated = true;
      continue;
    }
    const bytes = Buffer.from(part.body.data, "base64url");
    size += bytes.length;
    if (size > 64000) {
      truncated = true;
      break;
    }
    const decoded = bytes.toString("utf8");
    if (part.mimeType === "text/plain") plain.push(decoded);
    else html.push(botFeedText(decoded, 64000));
  }
  if (pending.length || nodes >= 100) truncated = true;
  const text = (plain.join("\n\n") || html.join("\n\n") || snippet).trim();
  return { text: text.slice(0, 3500), truncated: truncated || text.length > 3500 || (!plain.length && !html.length) };
}
export function parseGmailMessage(value: unknown, account: string): BotSourceItem | null {
  if (
    !isRecord(value) ||
    !gmailId(value.id) ||
    !gmailId(value.threadId) ||
    !isRecord(value.payload) ||
    !Array.isArray(value.payload.headers)
  )
    throw new BotProviderError("invalidResponse");
  const labels = Array.isArray(value.labelIds) ? value.labelIds : [];
  if (!labels.includes("INBOX") || labels.some((v) => ["SENT", "DRAFT", "SPAM", "TRASH"].includes(String(v))))
    return null;
  const headers = new Map<string, string[]>();
  for (const header of value.payload.headers.slice(0, 200)) {
    if (
      !isRecord(header) ||
      typeof header.name !== "string" ||
      typeof header.value !== "string" ||
      header.value.length > 8192
    )
      continue;
    const key = header.name.toLowerCase(),
      values = headers.get(key) ?? [];
    values.push(header.value);
    headers.set(key, values);
  }
  const one = (key: string) => (headers.get(key)?.length === 1 ? headers.get(key)![0]! : ""),
    from = mailSender(one("from"));
  if (!from || from === botMailAddress(account)) return null;
  const title = one("subject")
      .replace(/[\r\n\0]/g, " ")
      .slice(0, 240),
    messageId = one("message-id"),
    date = Number(value.internalDate),
    autoSubmitted =
      !/^<[^<>\s\r\n]{1,250}>$/.test(messageId) ||
      (headers.has("auto-submitted") && one("auto-submitted").trim().toLowerCase() !== "no") ||
      headers.has("list-id") ||
      headers.has("list-unsubscribe") ||
      /(?:bulk|junk|list)/i.test(one("precedence")) ||
      /(?:all|autoreply|oof)/i.test(one("x-auto-response-suppress")) ||
      /^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply)(?:[+._-]|@)/i.test(from),
    content = mailText(value.payload, typeof value.snippet === "string" ? value.snippet : "");
  return {
    id: String(value.id),
    title,
    text: content.text,
    truncated: content.truncated,
    url: "https://mail.google.com/mail/u/0/#inbox/" + value.threadId,
    publishedAt: Number.isFinite(date) && date > 0 ? date : null,
    digest: hash([value.id, title, content.text, messageId]),
    mail: { account, from, messageId, threadId: String(value.threadId), autoSubmitted },
  };
}
/** Only inbox messages received after connection of this integration are considered for replies. */
export async function collectGmailInbox(
  providers: BotProviders,
  owner: string,
  connectionId: string,
  query: string,
  since: number,
  signal: AbortSignal,
  cursor = "",
  known: (id: string) => Promise<boolean> = async () => false,
) {
  const row = await providers.connections.row(owner, connectionId, "gmail");
  if (!row.data.account) throw new BotError("connectionUnavailable", 409);
  const collected: BotSourceItem[] = [],
    seen = new Set<string>();
  let pageToken = cursor,
    limited = false;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
        labelIds: "INBOX",
        maxResults: "20",
        q: `${query ? "(" + query + ") " : ""}after:${Math.floor(since / 1000)}`,
        ...(pageToken ? { pageToken } : {}),
      }),
      listing = await providers.gmail(owner, connectionId, "messages?" + params, signal);
    if (listing.messages !== undefined && !Array.isArray(listing.messages))
      throw new BotProviderError("invalidResponse");
    const entries = (listing.messages as unknown[] | undefined) ?? [];
    for (const entry of entries.slice(0, 20)) {
      if (!isRecord(entry) || !gmailId(entry.id)) throw new BotProviderError("invalidResponse");
      if (seen.has(entry.id as string)) continue;
      seen.add(String(entry.id));
      if (await known(String(entry.id))) continue;
      const message = parseGmailMessage(
        await providers.gmail(
          owner,
          connectionId,
          "messages/" + encodeURIComponent(String(entry.id)) + "?format=full",
          signal,
        ),
        row.data.account,
      );
      if (message && (message.publishedAt ?? 0) >= since) collected.push(message);
    }
    if (!listing.nextPageToken) {
      pageToken = "";
      break;
    }
    if (typeof listing.nextPageToken !== "string" || listing.nextPageToken.length > 2048)
      throw new BotProviderError("invalidResponse");
    pageToken = listing.nextPageToken;
    limited = page === 4;
  }
  return { items: collected, limited, nextPageToken: pageToken };
}
export function botReplyMessageId(deliveryId: string) {
  if (!/^[a-f0-9-]{36}$/.test(deliveryId)) throw new BotError("invalidDelivery");
  return `<bot-${deliveryId}@panda-force.local>`;
}
/** The recipient and thread come from the saved source, never from the model or request body. */
export function gmailReplyRaw(account: string, item: BotSourceItem, text: string, deliveryId: string) {
  if (
    !item.mail ||
    !gmailId(item.mail.threadId) ||
    !/^<[^<>\s\r\n]{1,250}>$/.test(item.mail.messageId) ||
    !text.trim() ||
    text.length > 10000 ||
    /[\r\n\0]/.test(item.title)
  )
    throw new BotError("invalidDelivery");
  const from = botMailAddress(account),
    to = botMailAddress(item.mail.from);
  if (from === to) throw new BotError("invalidDelivery");
  const subject = /^re\s*:/i.test(item.title) ? item.title : "Re: " + item.title,
    words: string[] = [];
  let word = "";
  for (const character of subject) {
    if (Buffer.byteLength(word + character) > 42) {
      words.push("=?UTF-8?B?" + Buffer.from(word).toString("base64") + "?=");
      word = "";
    }
    word += character;
  }
  if (word) words.push("=?UTF-8?B?" + Buffer.from(word).toString("base64") + "?=");
  const mime = [
    "From: " + from,
    "To: " + to,
    "Subject: " + words.join("\r\n "),
    "In-Reply-To: " + item.mail.messageId,
    "References: " + item.mail.messageId,
    "Message-ID: " + botReplyMessageId(deliveryId),
    "Auto-Submitted: auto-replied",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text.trim())
      .toString("base64")
      .match(/.{1,76}/g)!
      .join("\r\n"),
    "",
  ].join("\r\n");
  return { raw: Buffer.from(mime).toString("base64url"), threadId: item.mail.threadId };
}
export async function sendGmailReply(
  providers: BotProviders,
  owner: string,
  connectionId: string,
  item: BotSourceItem,
  text: string,
  deliveryId: string,
  signal: AbortSignal,
) {
  const row = await providers.connections.row(owner, connectionId, "gmail");
  if (!row.data.account) throw new BotError("connectionUnavailable", 409);
  const value = await providers.gmail(
    owner,
    connectionId,
    "messages/send",
    signal,
    gmailReplyRaw(row.data.account, item, text, deliveryId),
    true,
  );
  if (!gmailId(value.id) || value.threadId !== item.mail!.threadId)
    throw new BotProviderError("invalidResponse", "unknown");
  return { id: String(value.id), threadId: String(value.threadId) };
}
export async function reconcileGmailReply(
  providers: BotProviders,
  owner: string,
  connectionId: string,
  deliveryId: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams({
      labelIds: "SENT",
      maxResults: "2",
      q: "rfc822msgid:" + botReplyMessageId(deliveryId),
    }),
    value = await providers.gmail(owner, connectionId, "messages?" + params, signal);
  if (value.messages === undefined) return null;
  if (
    !Array.isArray(value.messages) ||
    value.messages.length !== 1 ||
    !isRecord(value.messages[0]) ||
    !gmailId(value.messages[0].id)
  )
    throw new BotProviderError("invalidResponse");
  return { id: String(value.messages[0].id) };
}
