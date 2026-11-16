import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import type { Route, RouteContext } from "../../src/server/http/router.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { milvusHttpFixture } from "../support/milvus-http-fixture.js";

test("administrator storage checks use durable authenticated metadata tasks without reading content or invoking embeddings", async () => {
  const routes: Route[] = [],
    files = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-storage-maintenance-")),
    peer = milvusHttpFixture(),
    ctx = {} as RouteContext;
  let administrator = true,
    bodyReads = 0;
  const forbiddenRead = async (): Promise<never> => {
      bodyReads++;
      throw Error("Storage checks must not load source bodies");
    },
    errors: unknown[] = [],
    options = {
      stateRoot: root,
      appRoot: process.cwd(),
      env: {},
      content: { authorize: forbiddenRead, head: forbiddenRead, snapshot: forbiddenRead, current: forbiddenRead },
      owner: () => "owner",
      administrator: () => administrator,
      report: (error: unknown) => {
        errors.push(error);
      },
    };
  let feature = await createSearchFeature(options);
  routes.push(...feature.routes);
  const read = () => feature.api.vectorStorage(ctx, "vectors");
  try {
    await feature.api.addConnection(ctx, {
      id: "vectors",
      kind: "milvus",
      url: peer.endpoint,
      apiKey: "fixture-vector-key",
    });
    for (let i = 0; i < 3; i++) expect((await read()).state).toBe("idle");
    expect(peer.calls).toEqual([]);
    expect((await files.call("/api/search/vector-storage?connection=vectors&extra=1")).status).toBe(400);
    expect((await files.call("/api/search/vector-storage?connection=vectors&connection=vectors")).status).toBe(400);
    expect((await files.call("/api/search/vector-storage?connection=missing")).status).toBe(404);
    administrator = false;
    expect((await files.call("/api/search/vector-storage?connection=vectors")).status).toBe(403);
    expect(
      (
        await files.call("/api/search/vector-storage/check", "POST", {
          connection: "vectors",
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(403);
    administrator = true;
    expect(
      (
        await files.call(
          "/api/search/vector-storage/check",
          "POST",
          { connection: "vectors", operationId: randomUUID() },
          { origin: "https://elsewhere.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await files.call("/api/search/vector-storage/check", "POST", {
          connection: "vectors",
          operationId: randomUUID(),
          image: "arbitrary",
        })
      ).status,
    ).toBe(400);
    expect(
      (await files.call("/api/search/vector-storage?connection=vectors", "GET", undefined, { authorization: "" }))
        .status,
    ).toBe(401);
    expect(peer.calls).toEqual([]);
    const operationId = randomUUID(),
      first = await files.call("/api/search/vector-storage/check", "POST", { connection: "vectors", operationId });
    expect(first.status).toBe(200);
    const deadline = Date.now() + 2000;
    while ((await read()).state !== "ready") {
      if (Date.now() > deadline) throw Error("Storage check did not complete");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = await read(),
      before = peer.calls.length;
    expect(completed.automatic).toBeFalse();
    expect(completed.completedAt).not.toBeNull();
    expect(
      (await files.call("/api/search/vector-storage/check", "POST", { connection: "vectors", operationId })).status,
    ).toBe(200);
    await feature.close();
    feature = await createSearchFeature(options);
    routes.splice(0, routes.length, ...feature.routes);
    feature.start();
    expect(await read()).toEqual(completed);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peer.calls.length).toBe(before);
    expect(peer.calls).toEqual(["collections/list"]);
    expect((await feature.api.catalog(ctx)).binding.source).toBe("builtin");
    expect(bodyReads).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await feature.close();
    await files.close();
    await peer.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
