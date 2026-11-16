import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { PersonalContent } from "../../src/server/creative/personal.js";
import { creativeAssetRoutes } from "../../src/server/creative/assets/routes.js";
import { DocumentError } from "../../src/server/documents/errors.js";
import type { Route } from "../../src/server/http/router.js";

test("authenticated asset APIs isolate personal originals, copy into a project and download exact sandboxed bytes", async () => {
  const routes: Route[] = [],
    f = await projectFileApiFixture({ extraRoutes: routes });
  let owner = "alice",
    writable = true,
    allowed = true,
    workers = 0;
  let hold: Promise<void> | null = null,
    release = () => {},
    blockedReads = 0;
  const personal = new PersonalContent({
    contentRoot: f.root,
    assetRoot: f.assetRoot,
    stateRoot: join(f.root, "state"),
    owner: () => owner,
    authorize: () => {
      if (!allowed) throw new DocumentError("notFound", 404);
    },
    creation: () => {
      workers++;
      return { routes: [], start() {}, close: async () => {} };
    },
  });
  routes.push(
    ...creativeAssetRoutes({
      owner: () => owner,
      canWrite: () => writable && allowed,
      read: async (actor, project) => {
        if (!allowed) throw new DocumentError("notFound", 404);
        if (hold) {
          blockedReads++;
          await hold;
        }
        return project === "personal" ? personal.readCreations(actor) : f.application().creations;
      },
      write: async (actor, project) => {
        if (!allowed || !writable) throw new DocumentError("notFound", 404);
        return project === "personal"
          ? (await personal.forOwner(actor)).documents.creations
          : f.application().creations;
      },
    }),
  );
  try {
    expect(await f.call("/api/creative-assets?project=personal")).toMatchObject({ status: 200, body: { assets: [] } });
    expect(await f.call("/api/creative-assets/capabilities?project=personal")).toMatchObject({
      status: 200,
      body: { contribute: true },
    });
    expect(workers).toBe(0);
    await expect(lstat(join(f.root, "personal"))).rejects.toMatchObject({ code: "ENOENT" });
    const inspected = await f.raw(
      "/api/creative-assets/bundle-inspection?project=personal",
      "POST",
      zipSync({ "index.html": Buffer.from("<h1>Readonly inventory</h1>") }),
    );
    expect(inspected.status).toBe(200);
    expect((await inspected.json()).defaultEntry).toBe("index.html");
    expect(workers).toBe(0);
    await expect(lstat(join(f.root, "personal"))).rejects.toMatchObject({ code: "ENOENT" });
    const id = "c-" + randomUUID(),
      query = new URLSearchParams({
        project: "personal",
        kind: "web",
        id,
        operationId: randomUUID(),
        title: "Personal page",
        locale: "en",
        name: "index.html",
      }),
      bytes = Buffer.from("<h1>Personal original</h1><script>alert('never execute')</script>"),
      response = await f.raw("/api/creative-assets/import?" + query, "POST", bytes),
      saved = await response.json();
    expect(response.status).toBe(201);
    const targetId = "c-" + randomUUID(),
      copied = await f.call("/api/creative-assets/copy", "POST", {
        project: "personal",
        id,
        version: saved.asset.version,
        targetProject: "project-1",
        targetId,
        operationId: randomUUID(),
      });
    expect(copied.status).toBe(201);
    expect(copied.body.asset.copiedFrom.version).toBe(saved.asset.version);
    const download = await f.raw("/api/creative-assets/content?project=project-1&id=" + targetId);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toStartWith("attachment;");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
    expect(
      (
        await f.raw(
          "/api/creative-assets/content?project=project-1&id=" + targetId + "&version=" + copied.body.asset.version,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.raw("/api/creative-assets/content?project=project-1&id=" + targetId + "&version=" + "0".repeat(64)))
        .status,
    ).toBe(409);
    expect(await f.call("/api/creative-assets/item?project=personal&id=" + id)).toMatchObject({
      status: 200,
      body: { text: "Personal original" },
    });
    owner = "bob";
    expect((await f.call("/api/creative-assets/item?project=personal&id=" + id)).status).toBe(404);
    expect(workers).toBe(1);
    owner = "alice";
    writable = false;
    expect(await f.call("/api/creative-assets/capabilities?project=personal")).toMatchObject({
      status: 200,
      body: { contribute: false },
    });
    expect(
      (
        await f.call("/api/creative-assets/copy", "POST", {
          project: "personal",
          id,
          version: saved.asset.version,
          targetProject: "project-1",
          targetId: "c-" + randomUUID(),
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(404);
    writable = true;
    expect(
      (await f.raw("/api/creative-assets/import?" + query, "POST", bytes, { origin: "https://foreign.invalid" }))
        .status,
    ).toBe(403);
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: 2 }, () => f.call("/api/creative-assets/item?project=personal&id=" + id));
    const deadline = Date.now() + 3000;
    while (blockedReads < 2) {
      if (Date.now() > deadline) throw Error("Active reads did not reach the barrier");
      await Bun.sleep(10);
    }
    expect((await f.call("/api/creative-assets/item?project=personal&id=" + id)).status).toBe(429);
    hold = null;
    release();
    expect((await Promise.all(pending)).every((r) => r.status === 200)).toBeTrue();
    expect((await f.call("/api/creative-assets/item?project=personal&id=" + id)).status).toBe(200);
    allowed = false;
    await expect(personal.readCreations("alice").read("personal", id)).rejects.toMatchObject({ code: "notFound" });
  } finally {
    release();
    await personal.close();
    await f.close();
  }
}, 25000);
