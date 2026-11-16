import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { githubArchiveFixture } from "../support/github-archive.js";
import { sourceStageFixture, deferred } from "../support/source-staging.js";
import { sourceIngestionFixture } from "../support/source-provider.js";
import { PackageSourceProviders } from "../../src/server/packages/ingestion/providers.js";
import { sourceCaptureBytes } from "../../src/server/packages/ingestion/runtime.js";
import type { SourceHttpPort } from "../../src/server/packages/source-http.js";

const original = async (): Promise<Uint8Array> => {
  throw Error("Unexpected ZIP upload");
};

test("real source ingestion captures a complete GitHub archive into durable original files and survives restart", async () => {
  const f = await sourceStageFixture(),
    g = githubArchiveFixture("theme"),
    auth: string[][] = [];
  const image = new Uint8Array([0, 255, 18, 42]);
  g.contents.set("source/logo.png", image);
  g.archived.set("source/logo.png", image);
  const provider = new PackageSourceProviders(g.http, original, {
      async token(actor, purpose, id, signal) {
        expect(signal.aborted).toBe(false);
        auth.push([actor, purpose, id]);
        return "TEST_OWNER_BOUND_TOKEN";
      },
    }),
    r = sourceIngestionFixture(f, { provider });
  let closed = false;
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), {
      source: { kind: "github", ...g.request, ref: "main", repositoryId: 42 },
    });
    r.manager.poll();
    await r.manager.settle();
    const ready = r.manager.read("owner", "templates", stage.id);
    expect(ready.state).toBe("ready");
    const captured = await r.stages.templates.content("owner", stage.id);
    expect(captured.tree.files).toHaveLength(25);
    expect(captured.tree.read("source/logo.png")).toEqual(image);
    expect(auth.length).toBeGreaterThan(4);
    expect(
      auth.every((row) => JSON.stringify(row) === JSON.stringify(["owner", "templates", "chosen-connection"])),
    ).toBe(true);
    const path = join(f.contentRoot, ready.id, ready.digest + ".source"),
      bytes = await readFile(path);
    expect(bytes.toString()).not.toMatch(/TEST_OWNER_BOUND_TOKEN|TEST_DOWNLOAD_QUERY/);
    expect(await readdir(join(f.contentRoot, ready.id))).toEqual([ready.digest + ".source"]);
    expect(g.calls.filter((call) => call.url.includes("/git/blobs/"))).toHaveLength(0);
    expect(r.runtime.snapshot()).toEqual({ bytes: 0, active: 0 });
    await r.close();
    closed = true;
    const service = f.restart(),
      restored = await service.content("owner", ready.id);
    expect(restored.digest).toBe(captured.digest);
    expect(restored.tree.read("source/logo.png")).toEqual(image);
    await service.shutdown();
  } finally {
    if (!closed) await r.close();
    await f.dispose();
  }
});

test("archive cancellation holds its weighted runtime allocation until the real download has drained", async () => {
  const f = await sourceStageFixture(),
    g = githubArchiveFixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  let activeSignal: AbortSignal | undefined;
  const http: SourceHttpPort = {
      async get(request) {
        if (!request.url.startsWith("https://codeload.github.com")) return g.http.get(request);
        activeSignal = request.signal;
        entered.resolve();
        await release.promise;
        return { status: 200, headers: {}, bytes: g.archive() };
      },
    },
    provider = new PackageSourceProviders(http, original, { token: async () => "TEST_OWNER_BOUND_TOKEN" }),
    r = sourceIngestionFixture(f, { provider });
  try {
    const stage = await r.manager.submit("owner", "templates", randomUUID(), {
      source: { kind: "github", ...g.request, ref: "main", repositoryId: 42 },
    });
    const cost = sourceCaptureBytes(stage);
    expect(cost).toBe(stage.limits.totalBytes * 8 + stage.limits.archiveBytes * 6 + 128 * 1024 * 1024);
    r.manager.poll();
    await entered.promise;
    r.manager.cancel("owner", "templates", stage.id, r.manager.read("owner", "templates", stage.id).revision);
    expect(activeSignal!.aborted).toBe(true);
    expect(r.runtime.snapshot()).toEqual({ bytes: cost, active: 1 });
    release.resolve();
    await r.manager.settle();
    expect(r.manager.read("owner", "templates", stage.id).state).toBe("cancelled");
    expect(r.runtime.snapshot()).toEqual({ bytes: 0, active: 0 });
    expect(await readdir(join(f.contentRoot, stage.id))).toEqual([]);
  } finally {
    release.resolve();
    await r.close();
    await f.dispose();
  }
});
