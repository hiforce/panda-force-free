import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { autosaveCommand } from "../support/project-draft-fixture.js";
import { officeFixture } from "../support/office-presentation.js";
import { savedOriginalSources } from "../../src/server/content-sources/saved.js";
import { FileOriginalQueries } from "../../src/server/content-sources/reader.js";
import { DocumentFileProjects } from "../../src/server/documents/files/projects.js";
import { savedKnowledgeDocuments } from "../../src/server/knowledge/integration/saved-documents.js";
import { savedDocumentText } from "../../src/shared/documents/plain-text.js";
import { materializeSavedSource } from "../../src/server/content-sources/prepared.js";
import {
  projectCreationHtml,
  projectCreationFile,
  projectDocumentFile,
} from "../../src/server/project-content/paths.js";

const original = (kind: "web" | "slides") => ({
  id: "c-" + randomUUID(),
  operationId: randomUUID(),
  expectedVersion: null,
  kind,
  title: "Saved " + kind,
  locale: "en",
  name: kind === "web" ? "index.html" : "deck.pptx",
  bytes:
    kind === "web"
      ? Buffer.from("<h1>Launch evidence</h1><p>Exact original.</p><script>Never cite this</script>")
      : Buffer.from(officeFixture({ slides: 2 }).bytes()),
});

test("saved source selection preserves document-only defaults and explicit native kinds with exact versioned identities", async () => {
  const f = await projectFileApiFixture();
  try {
    const service = f.application().creations,
      web = original("web"),
      deck = original("slides"),
      a = await service.save("alice", "project-1", {
        ...web,
        resources: [{ name: "figure.png", bytes: Buffer.from("Owned original image") }],
      }),
      b = await service.save("alice", "project-1", deck);
    const captured = await f.project.coordinator.view(async (view) => {
      const legacy = await savedOriginalSources(view, f.owned, f.assetRoot, "project-1");
      expect(legacy.entries.map((row) => row.binding.kind)).toEqual(["document"]);
      const unified = await savedOriginalSources(view, f.owned, f.assetRoot, "project-1", [
        "document",
        "web",
        "slides",
      ]);
      expect(unified.entries).toHaveLength(3);
      const document = await unified.prepare(f.detail.document.id),
        old = await (await savedKnowledgeDocuments(view, "project-1")).read(f.detail.document.id);
      expect(document.metadata.version).toBe(f.detail.revision.id);
      expect(document.metadata.binding).toEqual({
        kind: "document",
        path: projectDocumentFile(f.detail.document.id),
        blob: view.version(projectDocumentFile(f.detail.document.id))!,
      });
      const html = await unified.prepare(web.id),
        slides = await unified.prepare(deck.id);
      expect(html.metadata.binding).toEqual({
        kind: "web",
        path: projectCreationFile(web.id),
        blob: view.version(projectCreationFile(web.id))!,
        original: a.asset.source,
        resources: a.asset.resources,
      });
      expect(html.metadata.version).toBe(a.asset.version);
      expect(slides.metadata.version).toBe(b.asset.version);
      expect(slides.metadata.binding.kind).toBe("slides");
      html.metadata.binding.kind = "document";
      unified.entries.find((row) => row.id === web.id)!.version = "Mutated consumer metadata";
      const freshHtml = await unified.prepare(web.id);
      expect(freshHtml.metadata).toMatchObject({
        version: a.asset.version,
        binding: { kind: "web" },
      });
      return { document, old, html: freshHtml, slides };
    });
    const document = await materializeSavedSource(captured.document),
      html = await materializeSavedSource(captured.html),
      slides = await materializeSavedSource(captured.slides);
    expect(document.text).toBe(captured.old.source.text);
    expect(document.sections).toEqual(captured.old.source.sections);
    expect(html.text).toBe("Launch evidence\nExact original.");
    expect(slides.sections.map((section) => section.id)).toEqual(["slide-1", "slide-2"]);
    expect(slides.text).toContain("Hello world");
    const before = await f.project.coordinator.view(
      async (view) =>
        (await savedOriginalSources(view, f.owned, f.assetRoot, "project-1", ["document", "web", "slides"])).head,
    );
    await f.project.drafts.put(autosaveCommand());
    const after = await f.project.coordinator.view(async (view) => {
      const sources = await savedOriginalSources(view, f.owned, f.assetRoot, "project-1", [
        "document",
        "web",
        "slides",
      ]);
      return { head: sources.head, document: await sources.prepare(f.detail.document.id) };
    });
    expect((await materializeSavedSource(after.document)).text).toBe(savedDocumentText(f.detail.revision).text);
    expect(after.head).toBe(before);
  } finally {
    await f.close();
  }
}, 20000);

test("discovery never parses raw originals; selected hydration rejects changed HTML/resources and trash", async () => {
  const f = await projectFileApiFixture();
  try {
    const web = original("web"),
      resource = Buffer.from("Source resource bytes"),
      saved = await f
        .application()
        .creations.save("alice", "project-1", { ...web, resources: [{ name: "figure.png", bytes: resource }] }),
      queries = new FileOriginalQueries(new DocumentFileProjects(f.root, () => {}), f.assetRoot);
    const before = await queries.metadata("project-1", ["web"]);
    await writeFile(join(f.owned.directory, projectCreationHtml(web.id)), "Changed without a save");
    expect(await queries.metadata("project-1", ["web"])).toEqual(before);
    expect(
      (await queries.current("project-1", [f.detail.document.id], ["document", "web"])).map((row) => row.metadata.id),
    ).toEqual([f.detail.document.id]);
    await expect(queries.current("project-1", [web.id], ["web"])).rejects.toThrow();
    await writeFile(join(f.owned.directory, projectCreationHtml(web.id)), web.bytes);
    const blob = join(f.assetRoot, "projects", "project-1", "blobs", saved.asset.resources[0]!.digest);
    await writeFile(blob, "Changed resource bytes");
    expect(await queries.metadata("project-1", ["web"])).toEqual(before);
    await expect(queries.current("project-1", [web.id], ["web"])).rejects.toThrow();
    await writeFile(blob, resource);
    const trashed = await f
      .application()
      .creations.setState("alice", "project-1", web.id, saved.asset.version, "trashed", randomUUID());
    expect((await queries.metadata("project-1", ["web"])).entries).toEqual([]);
    expect(await queries.current("project-1", [web.id], ["web"])).toEqual([]);
    await f
      .application()
      .creations.setState("alice", "project-1", web.id, trashed.asset.version, "saved", randomUUID());
    expect((await queries.snapshot("project-1", ["web"])).sources[0]!.text).toContain("Exact original.");
    const controller = new AbortController();
    controller.abort();
    await expect(queries.current("project-1", [web.id], ["web"], controller.signal)).rejects.toMatchObject({
      code: "unavailable",
    });
    let stale: Awaited<ReturnType<typeof savedOriginalSources>> | undefined;
    await f.project.coordinator.view(async (view) => {
      stale = await savedOriginalSources(view, f.owned, f.assetRoot, "project-1", ["web"]);
    });
    await expect(stale!.prepare(web.id)).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    await f.close();
  }
}, 20000);

test("original queries preserve read-only missing roots, capture selection before awaits and reauthorize before returning", async () => {
  const f = await projectFileApiFixture();
  try {
    let allowed = true,
      revokeAfterRead = false;
    const projects = new DocumentFileProjects(f.root, () => {
        if (!allowed) throw Error("Revoked");
      }),
      queries = new FileOriginalQueries(
        {
          authorize: projects.authorize.bind(projects),
          ifPresent: async (project, work) => {
            const result = await projects.ifPresent(project, work);
            if (revokeAfterRead) allowed = false;
            return result;
          },
        },
        f.assetRoot,
      );
    const absent = join(f.root, "projects", "missing");
    await expect(queries.metadata("missing", [])).rejects.toThrow();
    expect(await queries.snapshot("missing", ["web", "slides"])).toEqual({ head: "empty", sources: [] });
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
    const kinds: ("document" | "web")[] = ["document"],
      ids = new Set([f.detail.document.id]);
    const pending = queries.metadata("project-1", kinds, ids);
    kinds.splice(0, 1, "web");
    ids.clear();
    expect((await pending).entries.map((row) => row.binding.kind)).toEqual(["document"]);
    revokeAfterRead = true;
    await expect(queries.snapshot("project-1")).rejects.toThrow();
    await expect(queries.metadata("project-1")).rejects.toThrow();
  } finally {
    await f.close();
  }
}, 20000);

test("an ambiguous cross-kind identifier is rejected while historical document-only semantics remain intact", async () => {
  const f = await projectFileApiFixture();
  try {
    const web = original("web");
    await f.application().creations.save("alice", "project-1", web);
    const revision = randomUUID();
    await f.project.documents.put(
      {
        document: { ...f.detail.document, id: web.id, path: web.id + ".md", revisionId: revision },
        revision: { ...f.detail.revision, id: revision, documentId: web.id },
      },
      null,
      randomUUID(),
      { name: "Test", email: "test@example.test" },
    );
    await f.project.coordinator.view(async (view) => {
      const legacy = await savedOriginalSources(
        view,
        f.owned,
        f.assetRoot,
        "project-1",
        ["document"],
        new Set([web.id]),
      );
      expect(legacy.entries[0]!.binding.kind).toBe("document");
      expect((await legacy.prepare(web.id)).metadata.version).toBe(revision);
      await expect(
        savedOriginalSources(view, f.owned, f.assetRoot, "project-1", ["document", "web"], new Set([web.id])),
      ).rejects.toMatchObject({ code: "invalidFile" });
    });
  } finally {
    await f.close();
  }
}, 20000);
