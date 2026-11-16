import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { officeFixture } from "../support/office-presentation.js";
import { createSearchFeature } from "../../src/server/search/integration/feature.js";
import { documentSearchSource } from "../../src/server/search/integration/content-source.js";
import { originalSearchSource } from "../../src/server/search/integration/original-source.js";
import type { RouteContext } from "../../src/server/http/router.js";
import { projectCreationHtml } from "../../src/server/project-content/paths.js";

test("real file originals require explicit full-text kinds, hydrate current typed results and preserve document-only knowledge intent", async () => {
  const f = await projectFileApiFixture(),
    root = await mkdtemp(join(tmpdir(), "panda-native-search-")),
    legacy = documentSearchSource({
      project: f.application().queries,
      personal: async () => f.application().queries,
      authorizeProject: async () => {
        if (!f.grants.has("project-1")) throw Error("Revoked");
      },
    }),
    content = originalSearchSource({ documents: legacy, originals: async () => f.application().originals }),
    errors: unknown[] = [],
    ctx = {} as RouteContext;
  const feature = await createSearchFeature({
    stateRoot: root,
    appRoot: resolve("."),
    owner: () => "reader",
    administrator: () => true,
    content,
    report: (error) => errors.push(error),
  });
  const webId = "c-" + randomUUID(),
    slidesId = "c-" + randomUUID(),
    html = Buffer.from(
      "<h1>Ultraviolet launch</h1><p>Saved original evidence.</p><script>Invisible secretphrase</script>",
    );
  async function ready() {
    const deadline = Date.now() + 8000;
    for (;;) {
      const value = await feature.api.status(ctx, "project-1");
      if (value.state === "ready") return value;
      if (value.state === "failed" || Date.now() > deadline)
        throw Error("Original index did not become ready: " + value.failure);
      await Bun.sleep(15);
    }
  }
  async function query(query: string) {
    return feature.api.query(ctx, { project: "project-1", query });
  }
  try {
    const web = await f.application().creations.save("alice", "project-1", {
      id: webId,
      operationId: randomUUID(),
      expectedVersion: null,
      kind: "web",
      name: "launch.html",
      title: "Native launch",
      locale: "en",
      bytes: html,
    });
    const slides = await f.application().creations.save("alice", "project-1", {
      id: slidesId,
      operationId: randomUUID(),
      expectedVersion: null,
      kind: "slides",
      name: "launch.pptx",
      title: "Native deck",
      locale: "en",
      bytes: Buffer.from(officeFixture({ slides: 2 }).bytes()),
    });
    feature.start();
    await query("Exact source");
    const initial = await ready();
    expect(initial.settings.contentKinds).toBeUndefined();
    expect((await query("Ultraviolet")).hits).toEqual([]);
    expect(initial.documentCount).toBe(1);
    const originalHead = await legacy.head({
      owner: "reader",
      project: "project-1",
      source: "builtin",
      contentKinds: ["document"],
    });
    await feature.api.configure(ctx, {
      project: "project-1",
      source: "builtin",
      revision: initial.revision,
      settings: { ...initial.settings, contentKinds: ["web", "slides", "document"] },
    });
    const indexed = await ready();
    expect(indexed.documentCount).toBe(3);
    expect(indexed.settings.knowledge).toEqual(initial.settings.knowledge);
    const webHits = (await query("Ultraviolet")).hits;
    expect(webHits).toHaveLength(1);
    expect(webHits[0]).toMatchObject({
      kind: "web",
      id: webId,
      version: web.asset.version,
      url: "/project?id=project-1&asset=" + webId + "&assetVersion=" + web.asset.version,
    });
    expect((await query("secretphrase")).hits).toEqual([]);
    const slideHits = (await query("Hello world")).hits;
    expect(slideHits).toHaveLength(1);
    expect(slideHits[0]).toMatchObject({ kind: "slides", id: slidesId, version: slides.asset.version });
    expect((await query("Exact source")).hits).toHaveLength(1);
    expect(
      (await feature.api.preview(ctx, { project: "project-1", source: "builtin" })).documents.map((d) => d.kind).sort(),
    ).toEqual(["document", "slides", "web"]);
    await writeFile(
      join(f.owned.directory, projectCreationHtml(webId)),
      "Uncommitted replacement, not the saved original",
    );
    expect((await feature.api.preview(ctx, { project: "project-1", source: "builtin" })).total).toBe(3);
    await expect(query("Ultraviolet")).rejects.toThrow();
    expect((await query("Exact source")).hits).toHaveLength(1);
    const current = await feature.api.status(ctx, "project-1");
    await feature.api.configure(ctx, {
      project: "project-1",
      source: "builtin",
      revision: current.revision,
      settings: { ...current.settings, contentKinds: ["document"] },
    });
    const documentOnly = await ready();
    expect(documentOnly.documentCount).toBe(1);
    expect((await query("Ultraviolet")).hits).toEqual([]);
    expect((await query("Exact source")).hits).toHaveLength(1);
    expect(
      await legacy.head({ owner: "reader", project: "project-1", source: "builtin", contentKinds: ["document"] }),
    ).toBe(originalHead);
    f.grants.clear();
    await expect(query("Exact source")).rejects.toThrow();
    expect(errors).toEqual([]);
  } finally {
    await feature.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
