import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { FileDocumentKnowledgeContent } from "../../src/server/knowledge/integration/document-content.js";
import { defaultGenerationPolicy } from "../../src/shared/knowledge/generation.js";
import { projectFileApiFixture } from "../support/project-file-api-fixture.js";
import type { Route } from "../../src/server/http/router.js";

test("rule HTTP preserves authenticated ownership, closed inputs, same-origin mutation and metadata-only preview", async () => {
  const routes: Route[] = [],
    documents = await projectFileApiFixture({ extraRoutes: routes }),
    root = await mkdtemp(join(tmpdir(), "panda-generation-http-"));
  let owner = "alice",
    profiles = 0;
  const feature = createKnowledgeFeature({
    stateRoot: root,
    content: new FileDocumentKnowledgeContent(documents.application().projectContent),
    documents: async () => documents.application().projectContent,
    owner: () => owner,
    available: () => true,
    report() {},
    profile: async () => {
      profiles++;
      return { id: "test", engineId: "codex", model: "synthetic", activeTimeoutMs: 1000 };
    },
    engine: () => {
      throw Error("Rule configuration does not start an engine");
    },
  });
  routes.push(...feature.routes);
  try {
    const saved = await documents.application().navigation.create("alice", {
        id: randomUUID(),
        projectId: "project-1",
        treeVersion: 0,
        parentId: null,
        title: "Saved rule source",
        locale: "en",
      }),
      id = saved.operation.documentId,
      policy = {
        ...defaultGenerationPolicy(),
        enabled: true,
        purpose: "Explain saved decisions",
        backfill: false,
        selection: { ...defaultGenerationPolicy().selection, documents: [id] },
      },
      input = { project: "project-1", policy };
    expect((await documents.call("/api/knowledge/generation-policy?project=project-1")).body.policy.enabled).toBe(
      false,
    );
    expect((await documents.call("/api/knowledge/generation-preview", "POST", input)).body).toMatchObject({
      count: 1,
      documents: [id],
      truncated: false,
    });
    expect(
      (await documents.call("/api/knowledge/generation-policy", "PUT", input, { origin: "https://foreign.example" }))
        .status,
    ).toBe(403);
    expect((await documents.call("/api/knowledge/generation-policy", "PUT", { ...input, owner: "bob" })).status).toBe(
      400,
    );
    expect((await documents.call("/api/knowledge/generation-policy?project=project-1&project=other")).status).toBe(400);
    const response = await documents.call("/api/knowledge/generation-policy", "PUT", input);
    expect(response.status).toBe(200);
    expect(response.body.policy).toMatchObject({ enabled: true, revision: 1 });
    expect(response.body.policy).not.toHaveProperty("owner");
    expect(response.body.policy).not.toHaveProperty("observedCommit");
    expect((await documents.call("/api/knowledge/review-policy?project=project-1")).body.policy.automatic).toBe(false);
    expect((await documents.call("/api/knowledge/generation-policy", "PUT", input)).status).toBe(409);
    expect((await documents.call("/api/knowledge/tasks?project=project-1")).body.tasks).toEqual([]);
    expect(profiles).toBe(0);
    owner = "bob";
    expect((await documents.call("/api/knowledge/generation-policy?project=project-1")).body.policy.enabled).toBe(
      false,
    );
    owner = "alice";
    const raw = await documents.raw("/api/knowledge/generation-policy?project=project-1");
    expect(raw.headers.get("cache-control")).toBe("no-store");
    await raw.body?.cancel();
    documents.grants.delete("project-1");
    expect((await documents.call("/api/knowledge/generation-policy?project=project-1")).status).toBe(404);
  } finally {
    await feature.close();
    await documents.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
