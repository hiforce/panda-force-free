import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import type { RouteContext } from "../../src/server/http/router.js";
import { documentSearchSource } from "../../src/server/search/integration/content-source.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { currentDraftContent } from "../../src/server/project-content/drafts/content.js";

test("document search identity ignores knowledge-only commits but changes with saved originals", async () => {
  const f = await projectFileApiFixture();
  try {
    const queries = f.application().queries,
      scope = { owner: "reader", project: "project-1", source: "builtin", contentKinds: ["document"] as const },
      source = documentSearchSource({
        project: queries,
        personal: async () => queries,
        authorizeProject: async () => {},
      }),
      initial = await source.head(scope),
      provenance = await queries.savedHead(scope.project);
    await f.project.coordinator.mutate({
      operationId: "knowledge-only-search-version",
      author: { name: "Knowledge worker", email: "worker@example.test" },
      message: "Save isolated knowledge outcome",
      changes: [{ path: "knowledge/isolated.md", content: Buffer.from("Approved knowledge output.\n") }],
    });
    expect(await queries.savedHead(scope.project)).not.toBe(provenance);
    expect(await source.head(scope)).toBe(initial);
    expect((await source.snapshot(scope)).commit).toBe(initial);
    const detail = await queries.detail(scope.project, "doc-1");
    await f.application().changes.apply("operator:test-user", scope.project, "doc-1", {
      operationId: "search-version-source-change",
      expectedRevisionId: detail.revision.id,
      expectedVersion: detail.revision.number,
      expectedContentHash: detail.revision.contentHash,
      intentHash: "a".repeat(64),
      content: { ...currentDraftContent(detail), content: "Changed authoritative original." },
    });
    expect(await source.head(scope)).not.toBe(initial);
    expect((await source.snapshot(scope)).commit).toBe(await source.head(scope));
  } finally {
    await f.close();
  }
}, 15000);

test("knowledge-only notifications reuse the physical document index generation", async () => {
  const f = await projectFileApiFixture(),
    root = await mkdtemp(join(tmpdir(), "panda-search-projection-"));
  const feature = await createSearchFeature({
    stateRoot: root,
    appRoot: resolve("."),
    owner: () => "reader",
    administrator: () => true,
    report: (error) => {
      throw error;
    },
    content: documentSearchSource({
      project: f.application().queries,
      personal: async () => f.application().queries,
      authorizeProject: async () => {},
    }),
  });
  const ctx = {} as RouteContext;
  async function ready() {
    const deadline = Date.now() + 5000;
    for (;;) {
      const status = await feature.api.status(ctx, "project-1");
      if (status.state === "ready") return;
      if (status.state === "failed" || Date.now() > deadline) throw Error("Index failed to become ready");
      await Bun.sleep(10);
    }
  }
  try {
    feature.start();
    await feature.api.query(ctx, { project: "project-1", query: "Exact source" });
    await ready();
    const directory = join(root, "search", "text"),
      before = await readdir(directory);
    expect(before).toHaveLength(1);
    await f.project.coordinator.mutate({
      operationId: "knowledge-only-index-notification",
      author: { name: "Knowledge worker", email: "worker@example.test" },
      message: "Save isolated knowledge outcome",
      changes: [{ path: "knowledge/isolated.md", content: Buffer.from("Approved knowledge output.\n") }],
    });
    await feature.changed("project-1");
    await ready();
    expect(await readdir(directory)).toEqual(before);
    expect((await feature.api.query(ctx, { project: "project-1", query: "Exact source" })).hits).toHaveLength(1);
  } finally {
    await feature.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
