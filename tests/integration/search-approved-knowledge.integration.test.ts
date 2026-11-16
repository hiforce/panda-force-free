import { readFile, writeFile } from "node:fs/promises";
import { SearchAudits } from "../../src/server/search/storage/audits.js";
import { checkSearchGeneration } from "../../src/server/search/audit/check.js";
import { projectKnowledgeFile } from "../../src/server/project-content/paths.js";
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { knowledgeCatalogFixture } from "../support/knowledge-catalog-fixture.js";
import { FileApprovedKnowledgeReader } from "../../src/server/knowledge/integration/approved-reader.js";
import { documentSearchSource } from "../../src/server/search/integration/content-source.js";
import { LocalTextIndex, generationName } from "../../src/server/search/providers/local.js";
import { SearchIndexer, type SearchRuntime } from "../../src/server/search/indexer.js";
import { ContentSearch } from "../../src/server/search/service.js";
import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import type { SearchVectorDocument, VectorIndexProvider } from "../../src/server/search/ports.js";
import { currentDraftContent } from "../../src/server/project-content/drafts/content.js";
import { richDocumentFromMarkdown } from "../../src/server/documents/rich-codec.js";
import { SearchEmbeddingService } from "../../src/server/search/embeddings/service.js";
import { embeddingPolicy } from "../../src/server/search/embeddings/policy.js";

test("real approved knowledge has its own semantic identity, all sources and current eligibility", async () => {
  const f = await knowledgeCatalogFixture(),
    db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    scope = { source: "builtin", owner: f.owner, project: f.admission.project },
    approved = new FileApprovedKnowledgeReader(
      f.catalog,
      async () => f.documents.application().projectContent,
      () => {},
    ),
    content = documentSearchSource({
      project: f.documents.application().queries,
      personal: async () => f.documents.application().queries,
      authorizeProject: async (_owner, project) => f.documents.application().projectContent.authorize(project),
    }),
    text = new LocalTextIndex(join(f.root, "indexes"), resolve("src/server/search/worker-entry.ts"));
  let built: SearchVectorDocument[] = [],
    revoke = false;
  const vectors: VectorIndexProvider = {
      fingerprint: () => "fixture-vectors",
      health: async () => true,
      audit: async () => ({ count: built.length, checks: ["fixture-vectors"] }),
      storageHealth: async () => true,
      build: async (name, records) => {
        built = structuredClone(records);
        return { name, provider: "milvus" };
      },
      drop: async () => {},
      query: async () => {
        if (revoke) f.documents.grants.clear();
        return [
          {
            id: f.record.id,
            version: f.record.version,
            title: "Provider title",
            snippet: "<script>untrusted provider text</script>",
            score: 1,
          },
        ];
      },
    },
    embeddingErrors: unknown[] = [],
    embeddings = new SearchEmbeddingService(
      join(f.root, "embedding-usage.sqlite"),
      join(f.root, "embedding-cache"),
      "shared-project-test",
      embeddingPolicy(),
      (error) => embeddingErrors.push(error),
    ),
    runtime: SearchRuntime = {
      source: (id) => sources.get(id),
      text: () => text,
      vectors: (_source, actor) => ({
        ...vectors,
        query: async (ref, query, limit, signal) => {
          await embeddings
            .provider(
              {
                dimensions: 4,
                fingerprint: () => "fixture-model",
                health: async () => true,
                embed: async (texts) => texts.map(() => [1, 0, 0, 0]),
              },
              "fixture-connection",
              actor,
            )
            .embed([query], signal, "query");
          return vectors.query(ref, query, limit, signal);
        },
      }),
      analyzer: async () => builtinAnalyzer(),
      generation: generationName,
    },
    errors: unknown[] = [],
    indexer = new SearchIndexer(jobs, content, runtime, (error) => errors.push(error), approved),
    search = new ContentSearch(jobs, content, runtime, () => indexer.kick(), approved),
    settings = {
      ...DEFAULT_SEARCH_SETTINGS,
      enabled: true,
      vector: true,
      knowledge: { ...DEFAULT_SEARCH_SETTINGS.knowledge, mode: "project" as const },
    };
  try {
    f.complete();
    await search.configure(scope, settings, 0);
    indexer.start();
    const deadline = Date.now() + 10000;
    while (jobs.get(scope)?.state !== "ready") {
      if (Date.now() > deadline) throw Error("Approved index did not finish");
      await Bun.sleep(20);
    }
    expect(errors).toEqual([]);
    expect(built).toHaveLength(1);
    expect(built[0]!.id).toBe(f.record.id);
    expect(f.input.scope.ids).not.toContain(built[0]!.id);
    expect(built[0]!.version).toBe(f.record.version);
    const audits = new SearchAudits(db),
      ticket = audits.claim(jobs.get(scope)!, 1)!,
      auditPorts = { ledger: jobs, content, runtime, knowledge: approved };
    const healthy = await checkSearchGeneration(auditPorts, ticket, new AbortController().signal);
    expect(healthy.status).toBe("healthy");
    expect(healthy.checks).toContain("knowledge.approved-files-and-citations");
    const path = join(f.documents.owned.directory, projectKnowledgeFile(f.record.id)),
      bytes = await readFile(path);
    await writeFile(path, "{}\n");
    expect(await checkSearchGeneration(auditPorts, ticket, new AbortController().signal)).toMatchObject({
      status: "unavailable",
      action: "none",
    });
    expect(f.ledger.get(f.owner, f.admission.taskId).state).toBe("completed");
    await writeFile(path, bytes);
    // Freeze this physical generation so subsequent policy/source changes exercise retained-result hydration.
    await indexer.close();
    const semantic = await search.query(scope, "durable", "semantic"),
      hit = semantic.hits[0]!;
    expect(hit.kind).toBe("knowledge");
    expect(hit.title).toBe(f.record.draft.title);
    expect(JSON.stringify(hit)).not.toContain("untrusted provider");
    expect(hit.url).toContain("knowledge=" + f.record.id);
    if (hit.kind !== "knowledge") throw Error("Expected independent approved record");
    expect(hit.sources.map((source) => source.id).sort()).toEqual([...f.input.scope.ids].sort());
    expect(hit.sources.every((source) => source.url.includes("document=" + source.id))).toBeTrue();
    const hybrid = await search.query(scope, "durable", "hybrid");
    expect(hybrid.hits.some((value) => value.kind === "knowledge")).toBeTrue();
    expect(hybrid.hits.some((value) => value.kind !== "knowledge" && value.title === "Storage")).toBeTrue();
    const member = { ...scope, owner: "project-member" },
      memberResult = await search.query(member, "durable", "semantic");
    expect(memberResult.hits.map((value) => value.id)).toEqual([f.record.id]);
    expect(jobs.get(member)?.key).toBe(jobs.get(scope)?.key);
    expect(jobs.get(member)?.owner).toBe(scope.owner);
    expect(embeddings.usage(scope.owner).calls).toBe(1);
    expect(embeddings.usage(member.owner).calls).toBe(1);
    expect(embeddingErrors).toEqual([]);
    const row = jobs.get(scope)!;
    jobs.configure(
      scope,
      { ...settings, knowledge: { ...settings.knowledge, exclude: [f.input.scope.ids[1]!] } },
      row.revision,
    );
    const excluded = await search.query(scope, "durable", "hybrid");
    expect(excluded.hits.some((value) => value.kind === "knowledge")).toBeFalse();
    expect(excluded.hits.some((value) => value.kind !== "knowledge")).toBeTrue();
    jobs.configure(scope, settings, jobs.get(scope)!.revision);
    const id = f.input.scope.ids[1]!,
      detail = await f.documents.application().queries.detail(scope.project, id);
    await f.documents.application().changes.apply(f.owner, scope.project, id, {
      operationId: randomUUID(),
      expectedRevisionId: detail.revision.id,
      expectedVersion: detail.revision.number,
      expectedContentHash: detail.revision.contentHash,
      intentHash: "a".repeat(64),
      content: {
        ...currentDraftContent(detail),
        content: "Changed source.",
        body: richDocumentFromMarkdown("Changed source."),
      },
    });
    const outdated = await search.query(scope, "durable", "semantic");
    expect(outdated.hits).toEqual([]);
    expect(outdated.state).toBe("queued");
    revoke = true;
    await expect(search.query(scope, "durable", "semantic")).rejects.toMatchObject({ code: "notFound" });
  } finally {
    await indexer.close();
    await embeddings.close();
    text.close();
    db.close();
    await f.close();
  }
}, 30000);
