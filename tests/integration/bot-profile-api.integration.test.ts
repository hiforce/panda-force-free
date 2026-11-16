import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createBotFeature } from "../../src/server/bots/feature.js";
import { createRouter } from "../../src/server/http/router.js";

test("Bot profile HTTP routes isolate private images, support cache validation and retain the legacy API", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-profile-http-"));
  const feature = createBotFeature({
    stateRoot: root,
    version: "fixture",
    connection: { mode: "isolated" },
    owner: (context) => String(context.req.headers["x-test-owner"] ?? "alice"),
    engine: () => {
      throw new Error("Profile changes must not start model work");
    },
  });
  const dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://localhost") }).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (path: string, data?: unknown, owner = "alice", method = data ? "POST" : "GET") =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", "x-test-owner": owner },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  try {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#386854" } })
      .png()
      .toBuffer();
    const created = await call("/api/bots", {
      name: "Helpful reviewer",
      code: "profile-reviewer",
      avatar: { type: "upload", data: "data:image/png;base64," + png.toString("base64") },
      persona: { role: "Reviewer", traits: "Careful", voice: "Warm", motto: "Details matter." },
    });
    expect(created.status).toBe(201);
    const bot = (await created.json()).bot;
    const path = "/api/bots/avatars/" + bot.avatar.id;
    const image = await call(path);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("cache-control")).toBe("private, no-cache");
    expect(image.headers.get("vary")).toBe("Cookie, Authorization");
    const etag = image.headers.get("etag")!;
    expect((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width).toBe(256);
    expect((await fetch(base + path, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await fetch(base + path, { headers: { "x-test-owner": "bob", "if-none-match": etag } })).status).toBe(404);
    expect((await call("/api/bots", { name: "Other", code: "other-avatar", avatar: bot.avatar }, "bob")).status).toBe(
      404,
    );
    const catalog = await (await call("/api/bots/catalog")).json();
    expect(catalog.bots[0].persona.role).toBe("Reviewer");
    expect(catalog.tasks).toBeUndefined();
    expect(JSON.stringify(catalog)).not.toContain("base64");
    const queue = await (await call("/api/bots/queue")).json();
    expect(queue.bots[0].role).toBe("Reviewer");
    expect(queue.bots[0].instructions).toBeUndefined();
    expect(queue.bots[0].persona).toBeUndefined();
    expect((await (await call("/api/bots")).json()).bots[0]).toEqual(bot);
    expect(
      (
        await call(
          "/api/bots/" + bot.id,
          { avatar: { type: "icon", icon: "panda", tone: "warning" } },
          "alice",
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect((await (await call("/api/bots/catalog")).json()).bots[0].avatar).toEqual({
      type: "icon",
      icon: "panda",
      tone: "warning",
    });
    expect((await call(path)).status).toBe(404);
  } finally {
    await feature.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
