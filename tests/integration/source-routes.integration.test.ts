import { expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { createAppFixture, waitFor } from "../support/app-fixture.mjs";
import { createPackageSourceFeature } from "../../src/server/package-sources/feature.js";
import { createRouter } from "../../src/server/http/router.js";
import type { SourceStageView } from "../../src/shared/packages/stages/contracts.js";
import type { SourceSnapshotDescriptor } from "../../src/shared/packages/sources/snapshot.js";
import type { TemplateSourceInspection } from "../../src/shared/templates/sources/contracts.js";

function archiveIntent(bytes: Uint8Array) {
  return {
    source: {
      kind: "zip-upload",
      name: "source.zip",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

test("application source routes authenticate, reject foreign origins, retain uploads across restart and keep source reading distinct from installation", async () => {
  const app = await createAppFixture(),
    cookies = new Map<string, string>(),
    archive = zipSync({ "theme/layout/index.ejs": new TextEncoder().encode("<h1>Native theme source</h1>") });
  async function call<T = { code: string }>(path: string, value?: unknown, origin?: string) {
    const response = await fetch(app.base + path, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        cookie: [...cookies.values()].join("; "),
        ...(origin ? { origin } : {}),
        ...(value instanceof Uint8Array
          ? { "content-type": "application/zip" }
          : { "content-type": "application/json" }),
      },
      ...(value === undefined
        ? {}
        : { body: value instanceof Uint8Array ? new Uint8Array(value) : JSON.stringify(value) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }
    return { status: response.status, value: (await response.json()) as T };
  }
  const input = { purpose: "templates", operationId: randomUUID(), request: archiveIntent(archive) };
  try {
    expect((await call("/api/package-sources/policy")).status).toBe(401);
    expect((await call("/api/package-sources", input)).status).toBe(401);
    expect((await call("/api/auth/login", { username: "fixture-owner", password: "visibility-test" })).status).toBe(
      200,
    );
    expect((await call("/api/auth/setup", { username: "fixture-owner" })).status).toBe(200);
    expect((await call("/api/package-sources/policy")).status).toBe(200);
    expect((await call("/api/package-sources", input, "https://foreign.invalid")).status).toBe(401);
    expect((await call("/api/package-sources/policy")).status).toBe(200);
    expect((await call("/api/package-sources", { ...input, image: "untrusted/worker" })).status).toBe(400);
    const before = (await call<unknown>("/api/template-catalog")).value,
      created = await call<SourceStageView>("/api/package-sources", input);
    expect(created.status).toBe(202);
    expect(created.value.state).toBe("reserved");
    expect((await call<SourceStageView>("/api/package-sources", input)).value).toEqual(created.value);
    const id = created.value.id,
      params = new URLSearchParams({ purpose: "templates", id });
    expect((await call("/api/package-sources/task?purpose=skills&id=" + id)).status).toBe(404);
    expect((await call("/api/package-sources/task?" + params + "&id=" + id)).status).toBe(400);
    await app.stop();
    await app.start();
    expect((await call<SourceStageView>("/api/package-sources/task?" + params)).value.state).toBe("reserved");
    const uploaded = await call<SourceStageView>(
      "/api/package-sources/upload?" + params + "&revision=" + created.value.revision,
      archive,
    );
    expect(uploaded.status).toBe(200);
    expect(uploaded.value.state).toBe("uploaded");
    const ready = await waitFor(async () => {
      const current = (await call<SourceStageView>("/api/package-sources/task?" + params)).value;
      return current.state === "ready" ? current : null;
    });
    const detail = await call<SourceSnapshotDescriptor>("/api/package-sources/inspect?" + params);
    expect(detail.status).toBe(200);
    expect(detail.value.files.map((file) => file.path)).toEqual(["theme/layout/index.ejs"]);
    expect(detail.value).not.toHaveProperty("resources");
    const discovery = await call<TemplateSourceInspection>("/api/templates/source-discovery?id=" + id);
    expect(discovery.status).toBe(200);
    expect(discovery.value.sourceDigest).toBe(ready.digest);
    expect(discovery.value.candidates).toEqual([
      { kind: "hexo-theme", root: "theme", name: "theme", evidence: ["theme/layout/index.ejs"] },
    ]);
    expect((await call<unknown>("/api/template-catalog")).value).toEqual(before);
    expect(
      (await call("/api/package-sources/remove", { purpose: "templates", id, revision: created.value.revision }))
        .status,
    ).toBe(409);
    const removed = await call<SourceStageView>("/api/package-sources/remove", {
      purpose: "templates",
      id,
      revision: ready.revision,
    });
    expect(removed.value).toMatchObject({ state: "removed", reservedBytes: 0 });
    expect((await call<SourceStageView[]>("/api/package-sources?purpose=templates")).value).toEqual([]);
  } finally {
    await app.dispose();
  }
}, 30000);

test("a rejected HTTP upload receives its retryable JSON response before the connection closes and consumes no original", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-source-route-")),
    feature = createPackageSourceFeature({ stateRoot: root, owner: () => "owner", runtime: { bytes: 1, parallel: 1 } }),
    dispatch = createRouter(feature.routes),
    server = createServer((req, res) => {
      void dispatch({ req, res, url: new URL(req.url!, "http://fixture.invalid") });
    }),
    archive = zipSync({ "source.txt": new TextEncoder().encode("Bounded original") });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing address");
    const base = `http://127.0.0.1:${address.port}`,
      stage = await feature.ingestion.submit("owner", "templates", randomUUID(), archiveIntent(archive)),
      response = await fetch(
        base +
          "/api/package-sources/upload?" +
          new URLSearchParams({ purpose: "templates", id: stage.id, revision: String(stage.revision) }),
        { method: "POST", body: new Uint8Array(archive) },
      );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ messageId: "sources.sourceTooLarge", code: "sourceTooLarge" });
    const foreign = await fetch(base + "/api/package-sources/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://foreign.invalid" },
      body: JSON.stringify({ purpose: "templates", id: stage.id, revision: stage.revision }),
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ messageId: "sources.identityRequired" });
    expect(feature.ingestion.read("owner", "templates", stage.id)).toEqual(stage);
    expect(() => feature.ingestion.read("stranger", "templates", stage.id)).toThrow("stageNotFound");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await feature.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
