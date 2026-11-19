import { createHash } from "node:crypto";
import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { XmlBudget, type XmlElement } from "../../packages/opc/xml.js";
import { BotError } from "../../../shared/bots/contracts.js";
import type { BotSourceItem } from "../../../shared/bots/integrations.js";
import { botRequest } from "../network.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function botFeedUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) throw new BotError("invalidUrl");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BotError("invalidUrl");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) ||
    url.href.length > 4096
  )
    throw new BotError("invalidUrl");
  return url.href;
}
/** Parsing HTML as inert text never loads referenced resources or grants feed instructions authority. */
export function botFeedText(html: string, maximum = 3500) {
  const pending: DefaultTreeAdapterMap["node"][] = [parseFragment(html.slice(0, 64000))],
    pieces: string[] = [];
  let size = 0;
  while (pending.length && size < maximum * 2) {
    const node = pending.pop()!;
    if ("tagName" in node && ["script", "style", "iframe", "object", "template"].includes(node.tagName)) continue;
    if ("value" in node) {
      pieces.push(node.value);
      size += node.value.length;
    }
    if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
  }
  return pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, maximum);
}
const children = (node: XmlElement, name: string) =>
  Array.from(node.childNodes).filter((n): n is XmlElement => n.nodeType === 1 && (n as XmlElement).localName === name);
const first = (node: XmlElement, ...names: string[]) => names.flatMap((name) => children(node, name)).find(Boolean);
function baseUrl(node: XmlElement, feed: string): string {
  const parents: XmlElement[] = [];
  for (
    let current: XmlElement | null = node;
    current;
    current = current.parentNode?.nodeType === 1 ? (current.parentNode as XmlElement) : null
  )
    parents.unshift(current);
  let base = feed;
  for (const parent of parents) {
    const value = parent.getAttributeNS("http://www.w3.org/XML/1998/namespace", "base");
    if (value)
      try {
        base = botFeedUrl(new URL(value, base).href);
      } catch {
        throw new BotError("invalidFeed");
      }
  }
  return base;
}
export function parseBotFeed(
  bytes: Uint8Array,
  url: string,
  now = Date.now(),
): { items: BotSourceItem[]; limited: boolean } {
  try {
    const doc = new XmlBudget({
        partBytes: 1024 * 1024,
        totalBytes: 1024 * 1024,
        nodes: 20000,
        partNodes: 20000,
        depth: 48,
        attributes: 32,
      }).read("feed", bytes),
      root = doc.documentElement!,
      atom = root.localName === "feed" && root.namespaceURI === "http://www.w3.org/2005/Atom",
      container = root.localName === "rss" ? first(root, "channel") : root,
      entries = atom
        ? children(root, "entry")
        : root.localName === "rss" && container
          ? children(container, "item")
          : root.localName === "RDF"
            ? children(root, "item")
            : null;
    if (!entries) throw new BotError("invalidFeed");
    const unique = new Map<string, BotSourceItem>();
    for (const entry of entries.slice(0, 100)) {
      const title = botFeedText(first(entry, "title")?.textContent ?? "", 240),
        text = botFeedText(first(entry, "encoded", "content", "description", "summary")?.textContent ?? ""),
        date = first(entry, "updated", "published", "pubDate", "date")?.textContent ?? "",
        timestamp = Date.parse(date),
        publishedAt = Number.isFinite(timestamp) ? timestamp : null;
      if ((!title && !text) || (publishedAt !== null && publishedAt > now + 300000)) continue;
      const linkNode = atom
        ? children(entry, "link").find((n) => !n.getAttribute("rel") || n.getAttribute("rel") === "alternate")
        : first(entry, "link");
      let link = "";
      try {
        const raw = atom ? linkNode?.getAttribute("href") : linkNode?.textContent;
        if (raw) link = botFeedUrl(new URL(raw.trim(), baseUrl(linkNode!, url)).href);
      } catch {
        /* Unsafe links are omitted; the entry remains readable as source text. */
      }
      const rawId =
          first(entry, "id", "guid")?.textContent?.trim() || link || [title, publishedAt ?? "", text].join("\n"),
        id = hash(rawId),
        digest = hash(JSON.stringify([title, text, link, publishedAt]));
      unique.set(id, { id, title, text, url: link, publishedAt, digest });
    }
    return { items: [...unique.values()], limited: entries.length > 100 };
  } catch (error) {
    if (error instanceof BotError) throw error;
    throw new BotError("invalidFeed");
  }
}
export interface BotFeedCursor {
  etag?: string;
  modified?: string;
}
export async function collectBotFeed(
  url: string,
  cursor: BotFeedCursor,
  signal: AbortSignal,
  send: typeof botRequest = botRequest,
) {
  let currentUrl = botFeedUrl(url),
    response: Awaited<ReturnType<typeof botRequest>> | undefined;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await send(currentUrl, {
      method: "GET",
      maxBytes: 1024 * 1024,
      signal,
      allowHttp: true,
      headers: {
        Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
        "Accept-Encoding": "identity",
        ...(currentUrl === url && cursor.etag ? { "If-None-Match": cursor.etag } : {}),
        ...(currentUrl === url && cursor.modified ? { "If-Modified-Since": cursor.modified } : {}),
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers?.location;
    if (!location || redirects === 3) throw new BotError("sourceUnavailable", 502);
    let target: string;
    try {
      target = botFeedUrl(new URL(location, currentUrl).href);
    } catch {
      throw new BotError("invalidFeedUrl");
    }
    if (currentUrl.startsWith("https:") && !target.startsWith("https:")) throw new BotError("invalidFeedUrl");
    // Every hop uses the same DNS-pinned public-address guard. Credentials are never forwarded.
    currentUrl = target;
  }
  if (!response) throw new BotError("sourceUnavailable", 502);
  if (response.status === 304) return { items: [], cursor, unchanged: true, limited: false };
  if (response.status === 429) throw new BotError("sourceRateLimited", 429);
  if (response.status !== 200) throw new BotError("sourceUnavailable", 502);
  const safeHeader = (name: string) => {
    const value = response.headers?.[name];
    return value && value.length <= 1024 && !/[\r\n\0]/.test(value) ? value : undefined;
  };
  return {
    ...parseBotFeed(response.body, currentUrl),
    unchanged: false,
    cursor: { etag: safeHeader("etag"), modified: safeHeader("last-modified") },
  };
}
