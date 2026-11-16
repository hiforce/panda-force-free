import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import { documentSearchSource } from "../../src/server/search/integration/content-source.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { currentDraftContent } from "../../src/server/project-content/drafts/content.js";
import type { Route, RouteContext } from "../../src/server/http/router.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";

test("restart automatically reconstructs corrupt index metadata from saved project rules without changing originals", async () => {
  const files = await projectFileApiFixture(),
    root = await mkdtemp(join(tmpdir(), "panda-search-metadata-"));
  const content = documentSearchSource({
      project: files.application().queries,
      personal: async () => {
        throw Error("Unexpected personal scope");
      },
      authorizeProject: async (_owner, id) => {
        if (!files.grants.has(id)) throw Error("denied");
      },
    }),
    options = {
      stateRoot: root,
      appRoot: resolve("."),
      content,
      owner: () => "owner",
      administrator: () => true,
      report: (error: unknown) => {
        throw error;
      },
    },
    ctx = {} as RouteContext,
    scope = { source: "builtin", project: "project-1", owner: "owner", contentKinds: ["document"] as const },
    original = await content.snapshot(scope);
  let feature = await createSearchFeature(options);
  try {
    await feature.api.configure(ctx, {
      project: scope.project,
      source: scope.source,
      settings: { ...DEFAULT_SEARCH_SETTINGS, enabled: true, exclude: ["excluded.md"] },
      revision: 0,
    });
    feature.start();
    await ready(feature.api, ctx);
    for (const descriptor of ["{broken-json", '{"text":true}', "null"]) {
      await feature.close();
      const db = new Database(join(root, "data", "search.sqlite"), { strict: true });
      const policy = db.query("SELECT * FROM search_project_policies").get();
      db.query("UPDATE search_scopes SET active=?").run(descriptor);
      db.close();
      feature = await createSearchFeature(options);
      feature.start();
      const recovered = await ready(feature.api, ctx);
      expect(recovered.ready).toBeTrue();
      expect(recovered.revision).toBe(1);
      expect(recovered.settings.exclude).toEqual(["excluded.md"]);
      expect((await feature.api.query(ctx, { project: scope.project, query: "Exact source" })).hits).toHaveLength(1);
      expect(await content.snapshot(scope)).toEqual(original);
      const after = new Database(join(root, "data", "search.sqlite"), { readonly: true });
      try {
        expect(after.query("SELECT * FROM search_project_policies").get()).toEqual(policy);
        expect(after.query("SELECT descriptor FROM search_retired WHERE descriptor=?").get(descriptor)).not.toBeNull();
      } finally {
        after.close();
      }
    }
    expect((await readdir(join(root, "search", "text"))).length).toBe(4);
  } finally {
    await feature.close();
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
async function ready(api: Awaited<ReturnType<typeof createSearchFeature>>["api"], ctx: RouteContext) {
  for (let i = 0; i < 100; i++) {
    const s = await api.status(ctx, "project-1");
    if (s.state === "ready") return s;
    if (s.state === "failed") throw Error(String(s.failure));
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error("Index did not activate");
}
test("file-backed search excludes dirty drafts, revalidates current saved versions and permissions, and admin testing never changes production", async () => {
  const routes: Route[] = [],
    files = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-search-api-")),
    ctx = {} as RouteContext;
  let admin = true,
    owner = "owner-a";
  const feature = await createSearchFeature({
    stateRoot: root,
    appRoot: resolve("."),
    content: documentSearchSource({
      project: files.application().queries,
      personal: async () => {
        throw Error("Not selected");
      },
      authorizeProject: async (_owner, id) => {
        if (!files.grants.has(id)) throw Error("denied");
      },
    }),
    owner: () => owner,
    administrator: () => admin,
    report: () => {},
  });
  routes.push(...feature.routes);
  try {
    feature.start();
    const p = { project: "project-1", query: "Exact source" };
    expect((await feature.api.query(ctx, p)).hits).toEqual([]);
    await ready(feature.api, ctx);
    expect((await feature.api.query(ctx, p)).hits.map((h) => h.id)).toEqual(["doc-1"]);
    await feature.api.saveSource(ctx, {
      source: { id: "test", name: "Test source", kind: "local", connection: null, knowledge: null, enabled: true },
      revision: 0,
    });
    await feature.api.query(ctx, { ...p, source: "test" }, true);
    expect((await feature.api.catalog(ctx)).binding.source).toBe("builtin");
    await expect(feature.api.query(ctx, { ...p, source: "test" })).rejects.toThrow("invalidInput");
    const invalid = await files.call("/api/search/query", "POST", { ...p, source: "test" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.messageKey).toBe("search.invalidInput");
    expect((await files.call("/api/search/query", "POST", p, { origin: "https://other.example" })).status).toBe(403);
    const current = await files.application().queries.detail("project-1", "doc-1");
    expect(current.revision.content).toContain("Exact source");
    await files.application().editor.autosave("operator:test-user", "project-1", "doc-1", {
      operationId: "draft-search",
      version: 0,
      baseRevisionId: current.revision.id,
      working: { ...currentDraftContent(current), content: "unsavedonlymarker" },
    });
    await feature.changed("project-1");
    expect((await feature.api.query(ctx, { project: "project-1", query: "unsavedonlymarker" })).hits).toEqual([]);
    expect((await feature.api.query(ctx, p)).hits.map((h) => h.id)).toEqual(["doc-1"]);
    await files.application().editor.discard("operator:test-user", "project-1", "doc-1", {
      operationId: "discard-search",
      version: 1,
      baseRevisionId: current.revision.id,
    });
    await files.application().changes.apply("operator:test-user", "project-1", "doc-1", {
      operationId: "saved-search-change",
      expectedRevisionId: current.revision.id,
      expectedVersion: current.revision.number,
      expectedContentHash: current.revision.contentHash,
      intentHash: "a".repeat(64),
      content: { ...currentDraftContent(current), content: "Updated runners indexing" },
    });
    expect((await feature.api.query(ctx, p)).hits).toEqual([]);
    await ready(feature.api, ctx);
    expect((await feature.api.query(ctx, { project: "project-1", query: "running" })).hits).toHaveLength(1);
    const status = await feature.api.status(ctx, "project-1");
    await expect(
      feature.api.configure(ctx, {
        project: "project-1",
        source: "builtin",
        settings: { ...DEFAULT_SEARCH_SETTINGS, enabled: true, analyzer: "missing@1.0.0" },
        revision: status.revision,
      }),
    ).rejects.toThrow("configuration");
    expect((await feature.api.status(ctx, "project-1")).revision).toBe(status.revision);
    admin = false;
    await expect(feature.api.query(ctx, { ...p, source: "test" }, true)).rejects.toThrow("forbidden");
    owner = "owner-b";
    expect((await feature.api.status(ctx, "project-1")).ready).toBe(true);
    expect((await feature.api.query(ctx, { project: "project-1", query: "running" })).hits).toHaveLength(1);
    files.grants.clear();
    await expect(feature.api.query(ctx, p)).rejects.toThrow("denied");
    const db = await readFile(join(root, "data", "search.sqlite"));
    expect(db.includes(Buffer.from("Updated runners indexing"))).toBe(false);
  } finally {
    await feature.close();
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("project members share exclusions and a physical generation while query cursors and current grants remain principal-bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-shared-project-search-")),
    ctx = {} as RouteContext;
  let owner = "admin",
    commit = "saved-1";
  const members = new Set(["admin", "member"]),
    documents = Array.from({ length: 22 }, (_, i) => ({
      id: "doc-" + i,
      title: "Shared evidence " + i,
      text: "Durable shared evidence",
      version: "rev-1",
      locale: "en",
      path: `docs/${i}.md`,
      updatedAt: 1,
      ancestors: [],
    }));
  documents.push({ ...documents[0]!, id: "secret", path: "secret.md", title: "Excluded shared evidence" });
  const reads: string[] = [];
  const indexed = {
    authorize: async () => {},
    head: async () => commit,
    snapshot: async (scope: { owner: string }) => {
      reads.push(scope.owner);
      return { commit, documents: [...documents] };
    },
    current: async () => documents,
  };
  const feature = await createSearchFeature({
    stateRoot: root,
    appRoot: resolve("."),
    owner: () => owner,
    administrator: () => owner === "admin",
    report: () => {},
    content: {
      ...indexed,
      authorize: async (scope) => {
        if (!members.has(scope.owner)) throw Error("denied");
      },
    },
    indexContent: indexed,
  });
  try {
    feature.start();
    await feature.api.configure(ctx, {
      project: "project-1",
      source: "builtin",
      settings: { ...DEFAULT_SEARCH_SETTINGS, enabled: true, exclude: ["secret.md"] },
      revision: 0,
    });
    const first = await ready(feature.api, ctx),
      page = await feature.api.query(ctx, { project: "project-1", query: "shared evidence" });
    expect(page.hits.length).toBe(20);
    expect(page.nextCursor).not.toBeNull();
    expect(page.hits.some((h) => h.id === "secret")).toBeFalse();
    const generations = await readdir(join(root, "search", "text"));
    owner = "member";
    const status = await feature.api.status(ctx, "project-1");
    expect(status.revision).toBe(first.revision);
    expect(status.ready).toBeTrue();
    expect(status.projectPolicy).toEqual({ shared: true, needsReview: false, previous: 0 });
    expect(status.settings.exclude).toEqual(["secret.md"]);
    await expect(
      feature.api.query(ctx, { project: "project-1", query: "shared evidence", cursor: page.nextCursor }),
    ).rejects.toThrow("indexChanged");
    const memberPage = await feature.api.query(ctx, { project: "project-1", query: "shared evidence" });
    expect(memberPage.hits.map((h) => h.id)).toEqual(page.hits.map((h) => h.id));
    expect(await readdir(join(root, "search", "text"))).toEqual(generations);
    members.delete("admin");
    commit = "saved-2";
    documents[0] = { ...documents[0]!, version: "rev-2", text: "Updated shared evidence" };
    await feature.changed("project-1", "member");
    await ready(feature.api, ctx);
    expect((await feature.api.query(ctx, { project: "project-1", query: "updated" })).hits.map((h) => h.id)).toEqual([
      "doc-0",
    ]);
    expect(reads.every((actor) => actor === "admin")).toBeTrue();
    members.delete("member");
    await expect(feature.api.query(ctx, { project: "project-1", query: "updated" })).rejects.toThrow("denied");
  } finally {
    await feature.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("an explicit rebuild recreates a missing physical generation without changing the authoritative source", async () => {
  const root = await mkdtemp(join(tmpdir(), "panda-search-rebuild-")),
    ctx = {} as RouteContext;
  const options = {
    stateRoot: root,
    appRoot: resolve("."),
    owner: () => "owner-a",
    administrator: () => true,
    report: () => {},
    content: {
      authorize: async () => {},
      head: async () => "unchanged-saved-source",
      snapshot: async () => ({
        commit: "unchanged-saved-source",
        documents: [
          {
            id: "doc-1",
            title: "Durable storage",
            text: "Rebuild missing indexes from saved originals.",
            version: "rev-1",
            locale: "en",
            path: "doc.md",
            updatedAt: 1,
            ancestors: [],
          },
        ],
      }),
      current: async () => [
        {
          id: "doc-1",
          title: "Durable storage",
          text: "Rebuild missing indexes from saved originals.",
          version: "rev-1",
          locale: "en",
          path: "doc.md",
          updatedAt: 1,
          ancestors: [],
        },
      ],
    },
  };
  let feature = await createSearchFeature(options);
  try {
    feature.start();
    await feature.api.query(ctx, { project: "project-1", query: "durable" });
    await ready(feature.api, ctx);
    const directory = join(root, "search", "text"),
      [old] = await readdir(directory);
    expect(old).toBeDefined();
    await feature.close();
    await unlink(join(directory, old!));
    feature = await createSearchFeature(options);
    feature.start();
    await feature.api.retry(ctx, { source: "builtin", project: "project-1" });
    await ready(feature.api, ctx);
    const generations = await readdir(directory);
    expect(generations.length).toBe(1);
    expect(generations[0]).not.toBe(old);
    expect((await feature.api.query(ctx, { project: "project-1", query: "durable" })).hits).toHaveLength(1);
  } finally {
    await feature.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("a missing or corrupt cached local generation automatically rebuilds from unchanged saved sources", async () => {
  const files = await projectFileApiFixture(),
    root = await mkdtemp(join(tmpdir(), "panda-search-auto-repair-")),
    ctx = {} as RouteContext;
  const feature = await createSearchFeature({
    stateRoot: root,
    appRoot: resolve("."),
    owner: () => "reader",
    administrator: () => true,
    report: () => {},
    content: documentSearchSource({
      project: files.application().queries,
      personal: async () => files.application().queries,
      authorizeProject: async () => {},
    }),
  });
  try {
    feature.start();
    const query = { project: "project-1", query: "Exact source" },
      directory = join(root, "search", "text");
    await feature.api.query(ctx, query);
    await ready(feature.api, ctx);
    const source = await files.application().queries.savedHead("project-1");
    let previous = new Set(await readdir(directory));
    for (const corrupt of [false, true]) {
      expect((await feature.api.query(ctx, query)).hits).toHaveLength(1);
      const names = await readdir(directory),
        newest = names.find((name) => previous.has(name))!;
      if (corrupt) await writeFile(join(directory, newest), "{corrupt snapshot");
      else await unlink(join(directory, newest));
      const repairing = await feature.api.query(ctx, query);
      expect(repairing.hits).toEqual([]);
      expect(repairing.state).toBe("queued");
      await ready(feature.api, ctx);
      const after = await readdir(directory),
        replacement = after.filter((name) => !previous.has(name));
      expect(replacement).toHaveLength(1);
      previous = new Set(replacement);
      expect((await feature.api.query(ctx, query)).hits).toHaveLength(1);
      expect(await files.application().queries.savedHead("project-1")).toBe(source);
    }
  } finally {
    await feature.close();
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
