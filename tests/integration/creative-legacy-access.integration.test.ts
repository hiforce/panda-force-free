import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { creativeAssetRoutes } from "../../src/server/creative/assets/routes.js";
import { DocumentError } from "../../src/server/documents/errors.js";

test("existing projects support native imports under current read and contribution grants", async () => {
  let allowed = true,
    contribute = true,
    unavailable = false;
  const extraRoutes: ReturnType<typeof creativeAssetRoutes> = [],
    f = await projectFileApiFixture({ extraRoutes });
  const requireLegacy = (_owner: string, project: string, action: "read" | "contribute") => {
    if (unavailable) throw new DocumentError("unavailable", 503);
    if (project !== "legacy-project" || !allowed || (action === "contribute" && !contribute))
      throw new DocumentError("notFound", 404);
  };
  f.grants.add("legacy-project");
  const read = async (_owner: string, project: string) => {
    if (project === "legacy-project") requireLegacy(_owner, project, "read");
    else if (project !== "project-1") throw new DocumentError("notFound", 404);
    return f.application().creations;
  };
  extraRoutes.push(
    ...creativeAssetRoutes({
      owner: () => "fixture-owner",
      read,
      write: async (owner, project) => {
        if (project === "legacy-project") requireLegacy(owner, project, "contribute");
        return read(owner, project);
      },
      canWrite: (_owner, project) => project !== "legacy-project" || contribute,
    }),
  );
  try {
    expect(await f.call("/api/creative-assets/capabilities?project=legacy-project")).toEqual({
      status: 200,
      body: { contribute: true },
    });
    expect(await f.call("/api/creative-assets?project=legacy-project")).toEqual({
      status: 200,
      body: { assets: [], nextCursor: null },
    });
    expect((await f.call("/api/creative-assets?project=legacy-project&cursor=stale")).status).toBe(409);
    expect((await f.call("/api/creative-assets?project=legacy-project&state=invalid")).status).toBe(400);
    expect((await f.call("/api/creative-assets/capabilities?project=project-1")).body).toEqual({ contribute: true });
    expect((await f.call("/api/creative-assets?project=project-1")).body).toEqual({ assets: [], nextCursor: null });
    for (const path of [
      "/api/creative-assets?project=missing-project",
      "/api/creative-assets/capabilities?project=missing-project",
    ])
      expect((await f.call(path)).status).toBe(404);
    const query = new URLSearchParams({
      project: "legacy-project",
      id: "c-" + randomUUID(),
      operationId: "existing-project-import",
      kind: "web",
      title: "Existing project import",
      locale: "en",
      name: "original.html",
    });
    const imported = await f.raw(
      "/api/creative-assets/import?" + query,
      "POST",
      new TextEncoder().encode("<!doctype html><html><body><h1>Original content</h1></body></html>"),
    );
    expect(imported.status).toBe(201);
    expect((await f.call("/api/creative-assets?project=legacy-project")).body.assets).toHaveLength(1);
    f.reopen();
    expect((await f.call("/api/creative-assets?project=legacy-project")).body.assets[0].title).toBe(
      "Existing project import",
    );
    contribute = false;
    expect((await f.call("/api/creative-assets/capabilities?project=legacy-project")).body).toEqual({
      contribute: false,
    });
    allowed = false;
    for (const path of [
      "/api/creative-assets?project=legacy-project",
      "/api/creative-assets/capabilities?project=legacy-project",
    ])
      expect((await f.call(path)).status).toBe(404);
    allowed = true;
    unavailable = true;
    expect((await f.call("/api/creative-assets/capabilities?project=legacy-project")).status).toBe(503);
    unavailable = false;
    allowed = false;
    f.grants.clear();
    expect((await f.call("/api/creative-assets?project=project-1")).status).toBe(404);
    expect((await f.call("/api/creative-assets/import?project=legacy-project", "POST", {})).status).toBe(404);
  } finally {
    await f.close();
  }
});
