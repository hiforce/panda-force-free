import { botRequest } from "../../src/server/bots/network.js";
import { test, expect } from "bun:test";
import { botFeedUrl, botFeedText, parseBotFeed, collectBotFeed } from "../../src/server/bots/integrations/feed.js";
import { botSchedule, botScheduleDay, nextBotSchedule } from "../../src/server/bots/integrations/schedule.js";

const bytes = (xml: string) => Buffer.from(xml);
test("RSS and Atom collection preserve stable identities, strip active markup and resolve safe source links", () => {
  const rss = bytes(
      `<rss version="2.0"><channel><title>History</title><item><guid isPermaLink="false">one</guid><title>Ancient &amp; modern</title><description><![CDATA[<p>Hello <b>world</b>.</p><script>steal()</script><img src="http://127.0.0.1/private">]]></description><link>https://example.com/history</link></item><item><guid>future</guid><title>Not yet</title><pubDate>Wed, 01 Jan 2100 00:00:00 GMT</pubDate></item></channel></rss>`,
    ),
    first = parseBotFeed(rss, "https://example.com/feed", Date.UTC(2026, 10, 19));
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({
    title: "Ancient & modern",
    text: "Hello world .",
    url: "https://example.com/history",
    publishedAt: null,
  });
  expect(parseBotFeed(rss, "https://example.com/feed").items[0]!.id).toBe(first.items[0]!.id);
  const changed = parseBotFeed(bytes(rss.toString().replace("Hello", "Updated")), "https://example.com/feed");
  expect(changed.items[0]!.id).toBe(first.items[0]!.id);
  expect(changed.items[0]!.digest).not.toBe(first.items[0]!.digest);
  const atom = parseBotFeed(
    bytes(
      `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/articles/"><entry><id>urn:one</id><title>One</title><content type="html">&lt;p&gt;A &amp;amp; B&lt;/p&gt;</content><link rel="self" href="entry.xml"/><link href="one"/><updated>2026-11-18T00:00:00Z</updated></entry></feed>`,
    ),
    "https://example.com/feed",
  );
  expect(atom.items[0]).toMatchObject({ title: "One", text: "A & B", url: "https://example.com/articles/one" });
  expect(botFeedText('<a href="javascript:alert(1)">Read</a><style>bad</style>')).toBe("Read");
});
test("feed parsers reject entities, malformed, deep and oversized XML without fetching embedded resources", () => {
  for (const value of [
    "file:///etc/passwd",
    "https://user:pass@example.com/feed",
    "https://example.com:123/feed",
    "ftp://example.com/feed",
  ])
    expect(() => botFeedUrl(value)).toThrow();
  expect(botFeedUrl("http://example.com/feed")).toBe("http://example.com/feed");
  for (const xml of [
    '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title></item></channel></rss>',
    '<!DOCTYPE rss SYSTEM "https://example.com/external.dtd"><rss><channel/></rss>',
    "<rss><channel><item></channel>",
    "<html><body>Not a feed</body></html>",
    "<rss><channel>" + "<x>".repeat(55) + "deep" + "</x>".repeat(55) + "</channel></rss>",
    "<rss><channel>" + "a".repeat(1024 * 1024) + "</channel></rss>",
  ])
    expect(() => parseBotFeed(bytes(xml), "https://example.com/feed")).toThrow();
});
test("conditional feed reads reuse validators and do not turn redirects or provider failures into successful emptiness", async () => {
  const signal = new AbortController().signal;
  const value = await collectBotFeed("https://example.com/feed", { etag: '"v1"' }, signal, async (_url, options) => {
    expect(options.headers?.["If-None-Match"]).toBe('"v1"');
    expect(options.allowHttp).toBe(true);
    return { status: 304, type: "", body: Buffer.alloc(0) };
  });
  expect(value).toMatchObject({ items: [], unchanged: true, cursor: { etag: '"v1"' } });
  await expect(
    collectBotFeed("https://example.com/feed", {}, signal, async () => ({
      status: 302,
      type: "text/html",
      body: Buffer.alloc(0),
    })),
  ).rejects.toMatchObject({ code: "sourceUnavailable" });
});
test("schedules validate timezone and limits, coalesce outages, skip absent DST times and avoid a duplicate folded day", () => {
  expect(() => botSchedule({ kind: "interval", minutes: 0 })).toThrow();
  expect(() => botSchedule({ kind: "daily", time: "25:00", timezone: "UTC" })).toThrow();
  expect(() => botSchedule({ kind: "daily", time: "09:00", timezone: "Not/AZone" })).toThrow();
  expect(nextBotSchedule(botSchedule({ kind: "interval", minutes: 5 }), 100000)).toBe(400000);
  const spring = botSchedule({ kind: "daily", time: "02:30", timezone: "America/New_York" });
  expect(nextBotSchedule(spring, Date.parse("2026-03-08T05:00:00Z"))).toBe(Date.parse("2026-03-09T06:30:00Z"));
  const fall = botSchedule({ kind: "daily", time: "01:30", timezone: "America/New_York" });
  expect(nextBotSchedule(fall, Date.parse("2026-11-01T05:31:00Z"), "2026-11-01")).toBe(
    Date.parse("2026-11-02T06:30:00Z"),
  );
  if (fall.kind === "daily") expect(botScheduleDay(fall, Date.parse("2026-11-01T05:30:00Z"))).toBe("2026-11-01");
});

test("feed redirects remain bounded and refuse credential URLs, HTTPS downgrade and a private-address second hop", async () => {
  const signal = new AbortController().signal;
  await expect(
    collectBotFeed("https://example.com/feed", {}, signal, async () => ({
      status: 302,
      body: Buffer.alloc(0),
      headers: { location: "http://example.com/plain" },
    })),
  ).rejects.toMatchObject({ code: "invalidFeedUrl" });
  await expect(
    collectBotFeed("https://example.com/feed", {}, signal, async () => ({
      status: 302,
      body: Buffer.alloc(0),
      headers: { location: "https://secret@example.com/feed" },
    })),
  ).rejects.toMatchObject({ code: "invalidFeedUrl" });
  let calls = 0;
  await expect(
    collectBotFeed("https://example.com/feed", {}, signal, async () => {
      calls++;
      return { status: 302, body: Buffer.alloc(0), headers: { location: "/loop" } };
    }),
  ).rejects.toMatchObject({ code: "sourceUnavailable" });
  expect(calls).toBe(4);
  await expect(
    collectBotFeed("http://example.com/feed", {}, signal, async (url, options) =>
      url.includes("example.com")
        ? { status: 302, body: Buffer.alloc(0), headers: { location: "http://127.0.0.1/private" } }
        : botRequest(url, options),
    ),
  ).rejects.toMatchObject({ code: "targetDenied" });
});
