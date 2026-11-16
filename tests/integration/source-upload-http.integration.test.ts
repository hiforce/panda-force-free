import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { sourceStageFixture } from "../support/source-staging.js";
import { sourceIngestionFixture } from "../support/source-provider.js";
import { sourceUploadRequest } from "../../src/server/http/source-upload-body.js";
import { verifyRequestBody } from "../../src/server/request-bytes.js";

test("actual HTTP uploads stream after reservation and authenticated forwarding verifies the complete body before accepting an original", async () => {
  const f = await sourceStageFixture(),
    r = sourceIngestionFixture(f),
    modes: number[] = [];
  let verified = 0;
  const server = createServer(async (request, response) => {
    try {
      const id = new URL(request.url!, "http://example.test").searchParams.get("id")!,
        stage = r.manager.read("owner", "templates", id);
      if (stage.request.source.kind !== "zip-upload") throw Error("Expected upload");
      if (request.headers["x-fixture-signed"] === "1")
        verifyRequestBody(request, (body) => {
          verified++;
          if (createHash("sha256").update(body).digest("hex") !== request.headers["x-fixture-sha256"])
            throw Error("Internal body rejected");
        });
      const body = sourceUploadRequest(request, stage.request.source.bytes);
      modes.push(body.bufferedBytes ?? 0);
      const result = await r.manager.upload("owner", "templates", id, stage.revision, body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing HTTP address");
    const base = `http://127.0.0.1:${address.port}/upload`;
    for (const signed of [false, true]) {
      const stage = await r.manager.submit("owner", "templates", randomUUID(), f.request());
      if (stage.request.source.kind !== "zip-upload") throw Error("Expected ZIP intent");
      const response = await fetch(base + "?id=" + stage.id, {
        method: "POST",
        body: new Uint8Array(f.archive),
        ...(signed ? { headers: { "x-fixture-signed": "1", "x-fixture-sha256": stage.request.source.sha256 } } : {}),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { state: string }).state).toBe("uploaded");
      r.manager.poll();
      await r.manager.settle();
      expect(r.manager.read("owner", "templates", stage.id).state).toBe("ready");
    }
    expect(modes).toEqual([0, f.archive.length * 2]);
    expect(verified).toBe(1);
    const rejected = await r.manager.submit("owner", "templates", randomUUID(), f.request()),
      response = await fetch(base + "?id=" + rejected.id, {
        method: "POST",
        body: new Uint8Array(f.archive),
        headers: { "x-fixture-signed": "1", "x-fixture-sha256": "0".repeat(64) },
      });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "failed", failure: "invalidSource" });
    expect(verified).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await r.close();
    await f.dispose();
  }
});
