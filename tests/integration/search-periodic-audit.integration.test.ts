import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import { documentSearchSource } from "../../src/server/search/integration/content-source.js";
import { SearchError } from "../../src/shared/search/contracts.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { Route, RouteContext } from "../../src/server/http/router.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";

test("the real background timer repairs a deleted local index without any query or original/Git mutation", async () => {
  const routes: Route[] = [],
    files = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-periodic-audit-")),
    scope = { owner: "owner", project: "project-1", source: "builtin", contentKinds: ["document"] as const },
    members = new Set([scope.owner, "another-owner"]),
    content = documentSearchSource({
      project: files.application().queries,
      personal: async () => files.application().queries,
      authorizeProject: async (principal, id) => {
        if (!members.has(principal) || !files.grants.has(id)) throw new SearchError("forbidden", 403);
      },
    });
  let administrator = true,
    owner = scope.owner;
  const errors: unknown[] = [],
    feature = await createSearchFeature({
      stateRoot: root,
      appRoot: resolve("."),
      content,
      owner: () => owner,
      administrator: () => administrator,
      report: (error) => errors.push(error),
    }),
    ctx = {} as RouteContext;
  routes.push(...feature.routes);
  async function until(check: (status: Awaited<ReturnType<typeof feature.api.status>>) => boolean, timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const status = await feature.api.status(ctx, scope.project);
      if (check(status)) return status;
      if (Date.now() > deadline || status.state === "failed")
        throw Error("Background index recovery did not complete: " + status.state);
      await Bun.sleep(20);
    }
  }
  try {
    const original = await content.snapshot(scope),
      commit = await files.application().queries.savedHead(scope.project);
    feature.start();
    await feature.api.configure(ctx, {
      project: scope.project,
      source: scope.source,
      settings: { ...DEFAULT_SEARCH_SETTINGS, enabled: true },
      revision: 0,
    });
    await until((status) => status.state === "ready");
    const directory = join(root, "search", "text"),
      [before] = await readdir(directory);
    expect(before).toBeDefined();
    await unlink(join(directory, before!));
    const damaged = await until((status) => !!status.audit.latest?.repairQueued, 18000);
    expect(damaged.audit.latest).toMatchObject({ status: "missing", action: "rebuild", repairQueued: true });
    await until((status) => status.state === "ready");
    const after = await readdir(directory);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before);
    expect(await content.snapshot(scope)).toEqual(original);
    expect(await files.application().queries.savedHead(scope.project)).toBe(commit);
    expect((await feature.api.query(ctx, { project: scope.project, query: "Exact source" })).hits).toHaveLength(1);
    await feature.api.audit(ctx, { project: scope.project, source: scope.source });
    expect(
      (await until((status) => status.audit.current && status.audit.latest?.status === "healthy")).audit.latest?.checks,
    ).toContain("text.bytes");
    expect(
      (await files.call("/api/search/audit", "POST", { project: scope.project }, { origin: "https://other.example" }))
        .status,
    ).toBe(403);
    administrator = false;
    await expect(feature.api.audit(ctx, { project: scope.project })).rejects.toMatchObject({ code: "forbidden" });
    administrator = true;
    owner = "another-owner";
    const shared = await feature.api.status(ctx, scope.project);
    expect(shared.audit.latest?.status).toBe("healthy");
    await feature.api.audit(ctx, { project: scope.project });
    expect((await until((status) => status.audit.current && status.audit.latest?.status === "healthy")).revision).toBe(
      shared.revision,
    );
    expect(await readdir(directory)).toEqual(after);
    members.delete(owner);
    await expect(feature.api.audit(ctx, { project: scope.project })).rejects.toMatchObject({ code: "forbidden" });
    await expect(feature.api.status(ctx, scope.project)).rejects.toMatchObject({ code: "forbidden" });
    owner = scope.owner;
    files.grants.clear();
    await expect(feature.api.audit(ctx, { project: scope.project })).rejects.toMatchObject({ code: "forbidden" });
    expect(errors).toEqual([]);
  } finally {
    await feature.close();
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
