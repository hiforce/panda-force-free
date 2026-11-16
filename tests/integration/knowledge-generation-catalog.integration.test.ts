import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import { projectDocumentFixture } from "../support/project-document-fixture.js";
import { encodeProjectDocument } from "../../src/server/project-content/document-file.js";
import { projectDocumentFile } from "../../src/server/project-content/paths.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import type { Route } from "../../src/server/http/router.js";

test("rule catalog pages bind saved versions, reject stale previews and keep reads separate from inference", async () => {
  const routes: Route[] = [],
    documents = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-rule-catalog-")),
    author = { name: "Catalog fixture", email: "catalog@example.test" };
  let owner = "alice",
    available = true;
  const feature = createKnowledgeFeature({
    stateRoot: root,
    content: new FileDocumentKnowledgeContent(documents.application().projectContent),
    documents: async () => documents.application().projectContent,
    owner: () => owner,
    available: () => available,
    report(error) {
      throw error;
    },
    profile: async () => {
      throw Error("No inference belongs to catalog or preview");
    },
    engine() {
      throw Error("No engine belongs to this test");
    },
  });
  routes.push(...feature.routes);
  try {
    const before = await documents.snapshots.head();
    await documents.application().projectContent.write("project-1", (p) =>
      p.coordinator.plan(
        { operationId: randomUUID(), author, message: "Save catalog fixtures", intent: randomUUID() },
        async () => ({
          changes: Array.from({ length: 52 }, (_, i) => {
            const id = "catalog-" + String(i).padStart(3, "0");
            return {
              path: projectDocumentFile(id),
              content: encodeProjectDocument(projectDocumentFixture(1, id, "Private body is not part of the catalog")),
            };
          }),
        }),
      ),
    );
    const head = await documents.snapshots.head();
    expect(head).not.toBe(before);
    const first = await documents.call("/api/knowledge/generation-sources", "POST", {
      project: "project-1",
      offset: 0,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ commit: head, total: 53, next: 50 });
    expect(first.body.documents).toHaveLength(50);
    expect(JSON.stringify(first.body)).not.toContain("Private body");
    expect(first.body.documents[0]).toMatchObject({
      title: "Document catalog-000",
      breadcrumb: "",
      parentId: null,
    });
    expect(first.body.documents[0].space).toBeString();
    expect(first.body.documents[0]).not.toHaveProperty("owner");
    const last = await documents.call("/api/knowledge/generation-sources", "POST", {
      project: "project-1",
      offset: 50,
      commit: head,
    });
    expect(last.status).toBe(200);
    expect(last.body.next).toBeNull();
    expect(last.body.documents).toHaveLength(3);
    expect(new Set([...first.body.documents, ...last.body.documents].map((d: { id: string }) => d.id)).size).toBe(53);
    for (const data of [
      { offset: -1 },
      { offset: 54 },
      { offset: 0, owner: "bob" },
      { offset: 0, commit: "not-a-commit" },
    ])
      expect(
        (await documents.call("/api/knowledge/generation-sources", "POST", { project: "project-1", ...data })).status,
      ).toBe(400);
    expect(
      (
        await documents.call(
          "/api/knowledge/generation-sources",
          "POST",
          { project: "project-1", offset: 0 },
          { origin: "https://foreign.example" },
        )
      ).status,
    ).toBe(403);
    const policy = {
      ...defaultGenerationPolicy(),
      enabled: true,
      purpose: "Explain saved decisions",
      selection: { ...defaultGenerationPolicy().selection, all: true },
      backfill: false,
    };
    const preview = await documents.call("/api/knowledge/generation-preview", "POST", { project: "project-1", policy });
    expect(preview.body).toMatchObject({ commit: head, count: 53 });
    await documents.project.documents.put(
      projectDocumentFixture(2, "doc-1", "Changed after preview"),
      1,
      randomUUID(),
      author,
    );
    expect(
      (
        await documents.call("/api/knowledge/generation-sources", "POST", {
          project: "project-1",
          offset: 50,
          commit: head,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await documents.call("/api/knowledge/generation-policy", "PUT", {
          project: "project-1",
          policy,
          sourceCommit: preview.body.commit,
        })
      ).status,
    ).toBe(409);
    expect((await documents.call("/api/knowledge/generation-policy?project=project-1")).body.policy.revision).toBe(0);
    const current = await documents.call("/api/knowledge/generation-preview", "POST", { project: "project-1", policy });
    expect(
      (
        await documents.call("/api/knowledge/generation-policy", "PUT", {
          project: "project-1",
          policy,
          sourceCommit: current.body.commit,
        })
      ).body.policy,
    ).toMatchObject({ enabled: true, revision: 1 });
    expect((await documents.call("/api/knowledge/generation-status?project=project-1")).body).toMatchObject({
      enabled: true,
      policyRevision: 1,
      dailyUsed: 0,
      pendingTasks: 0,
      counts: { observed: 53, queued: 0 },
    });
    expect((await documents.call("/api/knowledge/review-policy?project=project-1")).body.policy.automatic).toBe(false);
    expect((await documents.call("/api/knowledge/tasks?project=project-1")).body.tasks).toEqual([]);
    owner = "bob";
    expect((await documents.call("/api/knowledge/generation-status?project=project-1")).body).toMatchObject({
      enabled: false,
      dailyUsed: 0,
      pendingTasks: 0,
      counts: { observed: 0 },
    });
    owner = "alice";
    available = false;
    expect(
      (
        await documents.call("/api/knowledge/generation-policy", "PUT", {
          project: "project-1",
          policy: { ...policy, revision: 1, enabled: false },
        })
      ).body.policy,
    ).toMatchObject({ enabled: false, revision: 2 });
    const currentHead = await documents.snapshots.head();
    expect(currentHead).toBe(current.body.commit);
    documents.grants.clear();
    expect(
      (await documents.call("/api/knowledge/generation-sources", "POST", { project: "project-1", offset: 0 })).status,
    ).toBe(404);
    expect((await documents.call("/api/knowledge/generation-status?project=project-1")).status).toBe(404);
  } finally {
    await feature.close();
    await documents.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
