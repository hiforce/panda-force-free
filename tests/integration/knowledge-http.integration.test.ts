import { expect, test } from "bun:test";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import type { Route } from "../../src/server/http/router.js";

test("knowledge HTTP uses authenticated ownership, same-origin mutation, closed inputs and metadata-only status", async () => {
  const routes: Route[] = [],
    documents = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-knowledge-http-"));
  let owner = "owner-a";
  const feature = createKnowledgeFeature({
    stateRoot: root,
    content: new FileDocumentKnowledgeContent(documents.application().projectContent),
    owner: () => owner,
    available: () => true,
    report() {},
    profile: async () => ({ id: "default", engineId: "codex", model: "fixture", activeTimeoutMs: 180000 }),
    engine: () => {
      throw new Error("This read-only HTTP fixture never starts an engine");
    },
  });
  routes.push(...feature.routes);
  try {
    const created = await documents.application().navigation.create("operator:test-user", {
      id: randomUUID(),
      projectId: "project-1",
      treeVersion: 0,
      parentId: null,
      title: "HTTP source",
      locale: "en",
    });
    const documentId = created.operation.documentId;
    const submitted = await documents.call("/api/knowledge/tasks", "POST", {
      id: randomUUID(),
      project: "project-1",
      ids: [documentId],
      purpose: "Explain the saved source",
    });
    expect(submitted.status).toBe(202);
    const id = submitted.body.task.id;
    const status = await documents.call("/api/knowledge/tasks/status?id=" + id);
    expect(status.status).toBe(200);
    expect(status.body.task).not.toHaveProperty("inputDigest");
    expect(status.body.task).not.toHaveProperty("sessionId");
    const inputRoot = join(root, "knowledge", "tasks", "inputs"),
      moved = inputRoot + ".saved";
    await rename(inputRoot, moved);
    try {
      expect((await documents.call("/api/knowledge/tasks/status?id=" + id)).status).toBe(200);
      expect((await documents.call("/api/knowledge/tasks/detail?id=" + id)).status).toBe(503);
    } finally {
      await rename(moved, inputRoot);
    }
    const denied = await documents.call(
      "/api/knowledge/review-policy",
      "PUT",
      { project: "project-1", automatic: true, revision: 0 },
      { origin: "https://foreign.example" },
    );
    expect(denied.status).toBe(403);
    const saved = await documents.call("/api/knowledge/review-policy", "PUT", {
      project: "project-1",
      automatic: true,
      revision: 0,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.policy).toEqual({ automatic: true, revision: 1 });
    expect(
      (
        await documents.call("/api/knowledge/review-policy", "PUT", {
          project: "project-1",
          automatic: false,
          revision: 0,
        })
      ).status,
    ).toBe(409);
    expect((await documents.call("/api/knowledge/review-policy?project=project-1&project=other")).status).toBe(400);
    expect(
      (
        await documents.call("/api/knowledge/tasks", "POST", {
          id: randomUUID(),
          owner: "somebody-else",
          project: "project-1",
          ids: ["doc-1"],
          purpose: "Injected owner",
        })
      ).status,
    ).toBe(400);
    const raw = await documents.raw("/api/knowledge/tasks/status?id=" + id);
    expect(raw.headers.get("cache-control")).toBe("no-store");
    await raw.body?.cancel();
    owner = "owner-b";
    expect((await documents.call("/api/knowledge/tasks/status?id=" + id)).status).toBe(404);
    expect((await documents.call("/api/knowledge/tasks/review?id=" + id)).status).toBe(404);
    expect((await documents.call("/api/knowledge/tasks?project=project-1")).body.tasks).toEqual([]);
    expect((await documents.call("/api/knowledge/review-policy?project=project-1")).body.policy).toEqual({
      automatic: false,
      revision: 0,
    });
  } finally {
    await feature.close();
    await documents.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
