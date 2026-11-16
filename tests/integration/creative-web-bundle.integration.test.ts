import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import type { Route } from "../../src/server/http/router.js";
import { creativeAssetRoutes } from "../../src/server/creative/assets/routes.js";
import { readSourceZip } from "../../src/server/packages/zip/read.js";
import { projectCreationHtml } from "../../src/server/project-content/paths.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

test("authenticated web bundles save atomically, replay across restart, copy independently and export exact files", async () => {
  const routes: Route[] = [],
    f = await projectFileApiFixture({ extraRoutes: routes });
  routes.push(
    ...creativeAssetRoutes({
      owner: () => "alice",
      read: async () => f.application().creations,
      write: async () => f.application().creations,
      canWrite: () => true,
    }),
  );
  try {
    const files = {
        "site/index.html": Buffer.from(
          '<h1>Retained bundle</h1><link rel="stylesheet" href="css/site.css"><img src="images/hero.png"><script>neverExecute()</script>',
        ),
        "site/css/site.css": Buffer.from("body{color:navy}"),
        "site/images/hero.png": new Uint8Array([0, 255, 1]),
        "site/empty.css": new Uint8Array(),
      },
      archive = zipSync(files),
      before = await f.snapshots.head(),
      inspection = await f.raw("/api/creative-assets/bundle-inspection?project=project-1", "POST", archive);
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toMatchObject({ files: 4, defaultEntry: "site/index.html" });
    expect(await f.snapshots.head()).toBe(before);
    expect(
      (
        await f.raw("/api/creative-assets/bundle-inspection?project=project-1", "POST", archive, {
          authorization: "Bearer wrong",
        })
      ).status,
    ).toBe(401);
    const id = "c-" + randomUUID(),
      query = new URLSearchParams({
        project: "project-1",
        id,
        operationId: randomUUID(),
        title: "Bundle original",
        locale: "en",
        entry: "site/index.html",
      }),
      url = "/api/creative-assets/import-bundle?" + query,
      imported = await f.raw(url, "POST", archive);
    expect(imported.status).toBe(201);
    const saved = await imported.json(),
      head = await f.snapshots.head();
    expect(saved.asset.kind).toBe("web");
    expect(saved.asset.source.name).toBe("site/index.html");
    expect(saved.asset.resources).toHaveLength(3);
    expect((await f.snapshots.entries(head)).some((entry) => entry.path === projectCreationHtml(id))).toBeTrue();
    f.reopen();
    const replay = await f.raw(url, "POST", archive);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(saved);
    expect(await f.snapshots.head()).toBe(head);
    const changed = zipSync({ ...files, "site/css/site.css": Buffer.from("body{color:red}") });
    expect((await f.raw(url, "POST", changed)).status).toBe(409);
    expect(await f.snapshots.head()).toBe(head);
    const original = await f.application().creations.original("project-1", id);
    for (const resource of original.resources)
      expect(resource.bytes).toEqual(Buffer.from(files[resource.name as keyof typeof files]));
    const exported = await f.raw(
      "/api/creative-assets/export-bundle?" +
        new URLSearchParams({ project: "project-1", id, version: saved.asset.version }),
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/zip");
    expect(exported.headers.get("cache-control")).toBe("private, no-store");
    const tree = await readSourceZip(new Uint8Array(await exported.arrayBuffer()));
    expect(tree.files.map((entry) => entry.path)).toEqual(Object.keys(files).sort());
    for (const [name, bytes] of Object.entries(files)) expect(tree.read(name)).toEqual(bytes);
    f.grants.add("project-2");
    const copied = await f
      .application()
      .creations.copyFrom(
        f.application().creations,
        "alice",
        { project: "project-1", id, version: saved.asset.version },
        "project-2",
        "c-" + randomUUID(),
        randomUUID(),
      );
    await f.application().creations.setState("alice", "project-1", id, saved.asset.version, "trashed", randomUUID());
    expect(
      (
        await f.raw(
          "/api/creative-assets/export-bundle?" +
            new URLSearchParams({ project: "project-1", id, version: saved.asset.version }),
        )
      ).status,
    ).toBe(404);
    const independent = await f.application().creations.original("project-2", copied.asset.id);
    expect(independent.bytes).toEqual(original.bytes);
    expect(independent.resources).toEqual(original.resources);
  } finally {
    await f.close();
  }
}, 20000);
