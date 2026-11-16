import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { fileKnowledgeGenerationSource } from "../../src/server/knowledge/integration/generation-content.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import type { DocumentProjectReads } from "../../src/server/documents/files/projects.js";

test("rule discovery uses navigation identities and bounded headers without decoding saved document bodies", async () => {
  const f = await projectFileApiFixture();
  try {
    const saved = await f.application().navigation.createFromSource(
        "alice",
        {
          id: randomUUID(),
          projectId: "project-1",
          treeVersion: 0,
          parentId: null,
          title: "Metadata-only rule source",
          locale: "en",
        },
        {
          identity: randomUUID(),
          prepare: async () => ({ body: richDocumentFromMarkdown("Private saved text"), images: [] }),
        },
      ),
      id = saved.operation.documentId,
      projects = f.application().projectContent;
    let documentReads = 0;
    const guarded: DocumentProjectReads = {
        authorize: projects.authorize.bind(projects),
        ifPresent: (project, work) =>
          projects.ifPresent(project, async (owned, view) =>
            work(owned, {
              commit: view.commit,
              paths: view.paths,
              assertHeld: view.assertHeld.bind(view),
              version: view.version.bind(view),
              read: async (path) => {
                if (path === projectDocumentFile(id)) {
                  documentReads++;
                  throw Error("Discovery must not read the source body");
                }
                return view.read(path);
              },
              inspect: async (path, read) => {
                if (path === projectDocumentFile(id)) {
                  documentReads++;
                  throw Error("Discovery must not inspect source content");
                }
                return view.inspect(path, read);
              },
            }),
          ),
      },
      source = fileKnowledgeGenerationSource(async (owner, _project) => {
        if (owner !== "alice") throw Error("forbidden");
        return guarded;
      }),
      before = await f.snapshots.head(),
      snapshot = await source.snapshot("alice", "project-1");
    expect(snapshot.commit).toBe(before);
    expect(new Set(snapshot.documents.map((document) => document.id))).toEqual(new Set(["doc-1", id]));
    const captured = await new FileDocumentKnowledgeContent(projects).capture("alice", {
      project: "project-1",
      ids: [id],
    });
    expect(captured.identities).toEqual([
      { id, version: snapshot.documents.find((document) => document.id === id)!.version },
    ]);
    await source.withSnapshot("alice", "project-1", (current) => {
      expect(current).toEqual(snapshot);
      return true;
    });
    expect(await source.head("alice", "project-1")).toBe(before);
    expect(documentReads).toBe(0);
    expect(await f.snapshots.head()).toBe(before);
    await expect(source.snapshot("bob", "project-1")).rejects.toThrow("forbidden");
    f.grants.delete("project-1");
    await expect(source.snapshot("alice", "project-1")).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await f.close();
  }
}, 30000);
