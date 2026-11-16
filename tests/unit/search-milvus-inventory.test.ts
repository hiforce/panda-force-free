import { expect, test } from "bun:test";
import { SearchHttp } from "../../src/server/search/providers/http.js";
import { MilvusStorage } from "../../src/server/search/providers/milvus-storage.js";
import { describeMilvusResource, milvusInventory } from "../../src/server/search/providers/milvus-inventory.js";

test("real HTTP preserves int64 collection identity and bounds namespace inventory without model requests", async () => {
  const name = "b".repeat(64),
    calls: string[] = [];
  let names: string[] = [],
    identity = "448707763883002001",
    marker = "panda-index/1/nonce";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path.endsWith("/list")) return Response.json({ code: 0, data: names });
      if (path.endsWith("/has")) return Response.json({ code: 0, data: { has: true } });
      const body = await request.json();
      return new Response(
        '{"code":0,"data":{"collectionName":' +
          JSON.stringify(body.collectionName) +
          ',"collectionID":' +
          identity +
          ',"description":' +
          JSON.stringify(marker) +
          "}}",
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const http = new SearchHttp({ id: "vectors", kind: "milvus", url: server.url.href.slice(0, -1) }),
    storage = new MilvusStorage(http, "test-installation");
  try {
    expect(await describeMilvusResource(storage, name, new AbortController().signal)).toEqual({
      name,
      identity,
      marker,
    });
    names = [
      ...Array.from({ length: 40 }, (_, i) => storage.collection(i.toString(16).padStart(64, "0"))),
      "foreign_collection",
      new MilvusStorage(http, "different-installation").collection(name),
    ];
    const first = await milvusInventory(storage, "", new AbortController().signal);
    expect(first.names).toHaveLength(32);
    expect(first.ownedNamespaceCount).toBe(40);
    const second = await milvusInventory(storage, first.next!, new AbortController().signal);
    expect(second.names).toHaveLength(8);
    expect(second.next).toBeNull();
    expect(new Set([...first.names, ...second.names]).size).toBe(40);
    expect(calls.every((path) => /^\/v2\/vectordb\/collections\/(has|describe|list)$/.test(path))).toBeTrue();
    identity = "9223372036854775808";
    await expect(describeMilvusResource(storage, name, new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
    });
    identity = "448707763883002001";
    marker = "x".repeat(4097);
    await expect(describeMilvusResource(storage, name, new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
    });
    names = [storage.collection(name), storage.collection(name)];
    await expect(milvusInventory(storage, "", new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
    });
    names = Array.from({ length: 8193 }, (_, i) => "collection" + i);
    await expect(milvusInventory(storage, "", new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
    });
  } finally {
    await server.stop(true);
  }
});
