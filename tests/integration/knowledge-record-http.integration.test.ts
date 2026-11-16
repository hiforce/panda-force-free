import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Route } from "../../src/server/http/router.js";
import { knowledgeCatalogFixture } from "../support/knowledge-catalog-fixture.js";
import { FileApprovedKnowledgeReader } from "../../src/server/knowledge/integration/approved-reader.js";
import { KnowledgeRecords } from "../../src/server/knowledge/catalog/read.js";
import { knowledgeRecordRoutes } from "../../src/server/knowledge/integration/record-routes.js";
import { projectKnowledgeFile } from "../../src/server/project-content/paths.js";
import { createKnowledgeFeature } from "../../src/server/knowledge/integration/feature.js";
import { createNativeKnowledgeFeature } from "../../src/server/knowledge/integration/bootstrap.js";
import { configureGenerationBudgets } from "../../src/server/knowledge/storage/generation-budget.js";
import { DEFAULT_GENERATION_BUDGET } from "../../src/shared/knowledge/generation-budget.js";

test("approved record HTTP shares project content without exposing another member's private task", async () => {
  const routes: Route[] = [],
    f = await knowledgeCatalogFixture(routes),
    errors: unknown[] = [];
  let owner = "another-member";
  const reader = new FileApprovedKnowledgeReader(
      f.catalog,
      async () => f.documents.application().projectContent,
      () => {},
    ),
    records = new KnowledgeRecords(reader),
    path = "/api/knowledge/records/detail?" + new URLSearchParams({ project: f.admission.project, id: f.record.id });
  routes.push(...knowledgeRecordRoutes(records, { owner: () => owner, report: (error) => errors.push(error) }));
  try {
    expect((await f.documents.call(path)).status).toBe(404);
    f.complete();
    const response = await f.documents.call(path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ record: f.record, receipt: f.admission.receipt });
    expect(() => f.ledger.get(owner, f.admission.taskId)).toThrow();
    expect(Object.keys(response.body).sort()).toEqual(["receipt", "record"]);
    expect((await f.documents.call(path + "&owner=" + f.owner)).status).toBe(400);
    expect((await f.documents.call(path + "&project=other")).status).toBe(400);
    expect((await f.documents.call(path, "POST", {})).status).toBe(405);
    const raw = await f.documents.raw(path);
    expect(raw.headers.get("cache-control")).toBe("no-store");
    await raw.body?.cancel();
    const denied = await f.documents.raw(path, "GET", undefined, { authorization: "" });
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
    owner = f.owner;
    f.documents.grants.clear();
    expect((await f.documents.call(path)).status).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);
test("production composition keeps approved record reads available when model generation is disabled", async () => {
  const routes: Route[] = [],
    f = await knowledgeCatalogFixture(routes);
  let engineCalls = 0;
  f.complete();
  const feature = createKnowledgeFeature({
    stateRoot: f.root,
    content: f.content,
    documents: async () => f.documents.application().projectContent,
    owner: () => "project-member",
    available: () => false,
    report: () => {},
    profile: async () => {
      throw Error("Read-only access must not select a model");
    },
    engine: () => {
      engineCalls++;
      throw Error("Read-only access must not start an engine");
    },
  });
  routes.push(...feature.routes);
  try {
    feature.start();
    expect((await f.documents.call("/api/knowledge/options")).body.available).toBeFalse();
    const response = await f.documents.call(
      "/api/knowledge/records/detail?" + new URLSearchParams({ project: f.admission.project, id: f.record.id }),
    );
    expect(response.status).toBe(200);
    expect(response.body.record).toEqual(f.record);
    expect(engineCalls).toBe(0);
  } finally {
    await feature.close();
    await f.close();
  }
}, 20000);
test("approved record HTTP fails closed on changed physical knowledge bytes", async () => {
  const routes: Route[] = [],
    f = await knowledgeCatalogFixture(routes);
  const records = new KnowledgeRecords(
    new FileApprovedKnowledgeReader(
      f.catalog,
      async () => f.documents.application().projectContent,
      () => {},
    ),
  );
  routes.push(...knowledgeRecordRoutes(records, { owner: () => f.owner, report: () => {} }));
  try {
    f.complete();
    await writeFile(join(f.documents.owned.directory, projectKnowledgeFile(f.record.id)), "{}");
    const response = await f.documents.call(
      "/api/knowledge/records/detail?" + new URLSearchParams({ project: f.admission.project, id: f.record.id }),
    );
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: "conflict" });
  } finally {
    await f.close();
  }
}, 20000);
test("an invalid administrator model or budget profile stops generation without hiding approved content or resetting persisted ceilings", async () => {
  const routes: Route[] = [],
    f = await knowledgeCatalogFixture(routes);
  f.complete();
  const path = join(f.root, "invalid-profile.json");
  await writeFile(
    path,
    JSON.stringify({
      schema: 1,
      enabled: true,
      id: "work",
      engineId: "codex",
      generationBudget: { installationDaily: -1 },
    }),
  );
  configureGenerationBudgets(f.db, { ...DEFAULT_GENERATION_BUDGET, installationDaily: 2, ownerDaily: 2 });
  let models = 0,
    reports = 0;
  const feature = createNativeKnowledgeFeature(
    {
      stateRoot: f.root,
      projectsRoot: f.root,
      engineId: "codex",
      connection: { mode: "fixture" },
      version: "test",
      models: async () => {
        models++;
        return {};
      },
      content: f.content,
      documents: async () => f.documents.application().projectContent,
      owner: () => "project-member",
      report() {
        reports++;
      },
    },
    { PANDA_FORCE_KNOWLEDGE_CONFIG_FILE: path },
  );
  routes.push(...feature.routes);
  try {
    feature.start();
    expect((await f.documents.call("/api/knowledge/options")).body.available).toBe(false);
    const response = await f.documents.call(
      "/api/knowledge/records/detail?" + new URLSearchParams({ project: f.admission.project, id: f.record.id }),
    );
    expect(response.status).toBe(200);
    expect(response.body.record).toEqual(f.record);
    expect(
      (await f.documents.call("/api/knowledge/generation-status?project=" + f.admission.project)).body.budget.limits
        .installationDaily,
    ).toBe(2);
    expect(models).toBe(0);
    expect(reports).toBe(1);
  } finally {
    await feature.close();
    await f.close();
  }
}, 30000);
