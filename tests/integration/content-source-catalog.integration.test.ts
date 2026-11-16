import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { nativeKnowledgeFixture } from "../support/native-knowledge-fixture.js";
import { contentSourceRoutes } from "../../src/server/content-sources/routes.js";
import { FileOriginalQueries } from "../../src/server/content-sources/reader.js";
import { savedSourcePage } from "../../src/server/content-sources/catalog.js";
import { createRouter } from "../../src/server/http/router.js";
import type { SavedSourceMetadata } from "../../src/shared/content-sources/contracts.js";

test("source pages fence a shared metadata snapshot and never require parsing originals", async () => {
  const f = await nativeKnowledgeFixture();
  const owner = "alice";
  let parsed = 0;
  const originals = new FileOriginalQueries(f.app.projectContent, f.assetRoot, async () => {
      parsed++;
      throw Error("Listing must not parse original content");
    }),
    routes = contentSourceRoutes({
      owner: () => owner,
      originals: async (actor, project) => {
        expect(actor).toBe(owner);
        await f.app.projectContent.authorize(project);
        return originals;
      },
    }),
    dispatch = createRouter(routes),
    server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer source-reader") {
        res.writeHead(401).end();
        return;
      }
      void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) });
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    read = (query: string, method = "GET") =>
      fetch(base + "/api/content-sources?" + query, { method, headers: { authorization: "Bearer source-reader" } });
  try {
    const before = await originals.metadata("project-1", ["web"]),
      response = await read("project=project-1&contentKinds=web");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.json();
    expect(page.sources.map((row: { id: string }) => row.id)).toEqual([f.saved.asset.id]);
    expect(page.sources[0].kind).toBe("web");
    expect(page.sources[0].url).toContain("assetVersion=" + f.saved.asset.version);
    expect(JSON.stringify(page)).not.toContain("Verified original content");
    expect(
      (await (await read("project=project-1")).json()).sources.every(
        (row: { kind: string }) => row.kind === "document",
      ),
    ).toBe(true);
    expect((await (await read("project=project-1&contentKinds=web&search=VERIFIED")).json()).total).toBe(1);
    expect((await (await read("project=project-1&contentKinds=web&search=absent")).json()).total).toBe(0);
    expect((await read("project=project-1&contentKinds=web&head=" + "b".repeat(64))).status).toBe(409);
    for (const query of [
      "",
      "project=../other",
      "project=project-1&owner=bob",
      "project=project-1&project=other",
      "project=project-1&contentKinds=web,web",
      "project=project-1&contentKinds=video",
      "project=project-1&offset=-1",
      "project=project-1&offset=10001",
      "project=project-1&search=" + "x".repeat(201),
    ])
      expect((await read(query)).status).toBe(400);
    expect((await fetch(base + "/api/content-sources?project=project-1")).status).toBe(401);
    expect((await read("project=project-1", "POST")).status).toBe(405);
    expect(parsed).toBe(0);
    expect((await originals.metadata("project-1", ["web"])).head).toBe(before.head);
    f.grants.delete("project-1");
    expect((await read("project=project-1&contentKinds=web")).status).toBe(404);
    expect(parsed).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test("source metadata paging retains exact page boundaries and rejects mutated cursors", async () => {
  let head = "a".repeat(64),
    reads = 0;
  const entries: SavedSourceMetadata[] = Array.from({ length: 205 }, (_, index) => ({
    id: "item-" + index,
    version: "v1",
    title: "Source " + index,
    locale: "en",
    path: "documents/item-" + index + ".panda.json",
    updatedAt: index,
    ancestors: [],
    binding: { kind: "document", path: "documents/item-" + index + ".panda.json", blob: "blob" },
  }));
  const originals = {
      async metadata() {
        reads++;
        return { head, entries };
      },
    },
    first = await savedSourcePage(originals, "project-1", {}),
    next = await savedSourcePage(originals, "project-1", { head: first.head, offset: first.nextOffset! }),
    last = await savedSourcePage(originals, "project-1", { head: first.head, offset: next.nextOffset! });
  expect(first.sources).toHaveLength(100);
  expect(next.sources).toHaveLength(100);
  expect(last.sources).toHaveLength(5);
  expect(last.nextOffset).toBeNull();
  expect(new Set([...first.sources, ...next.sources, ...last.sources].map((row) => row.id)).size).toBe(205);
  head = "c".repeat(64);
  await expect(savedSourcePage(originals, "project-1", { head: first.head, offset: 100 })).rejects.toThrow("changed");
  const before = reads;
  for (const input of [{ contentKinds: [] }, { offset: null }, { search: null }, { offset: 1.5 }, { head: "bad" }])
    await expect(savedSourcePage(originals, "project-1", input)).rejects.toThrow("invalidInput");
  expect(reads).toBe(before);
});
