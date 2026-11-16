import { openSearchDatabase } from "../../src/server/search/storage/database.js";
import { SearchJobs } from "../../src/server/search/storage/jobs.js";
import { SearchAudits } from "../../src/server/search/storage/audits.js";
import { SearchSourceRegistry } from "../../src/server/search/storage/registry.js";
import { DEFAULT_SEARCH_SETTINGS } from "../../src/shared/search/validation.js";
import { builtinAnalyzer } from "../../src/server/search/analyzers/registry.js";
import type { SearchAuditPorts } from "../../src/server/search/audit/check.js";
import type { TextIndexProvider } from "../../src/server/search/ports.js";
import type { SearchSettings } from "../../src/shared/search/contracts.js";

export function searchAuditFixture() {
  const db = openSearchDatabase(":memory:"),
    jobs = new SearchJobs(db),
    sources = new SearchSourceRegistry(db),
    audits = new SearchAudits(db);
  let head = "saved",
    fingerprint = "recipe-v1";
  const ports: SearchAuditPorts = {
      ledger: jobs,
      content: {
        authorize: async () => {},
        head: async () => head,
        snapshot: async () => ({ commit: head, documents: [] }),
        current: async () => [],
      },
      runtime: {
        source: (id) => sources.get(id),
        analyzer: async () => builtinAnalyzer(),
        vectors: () => null,
        generation: () => "unused",
        text: (source) => ({ ...provider, id: source.kind }),
      },
    },
    provider: TextIndexProvider = {
      id: "local",
      build: async (name) => ({ name, provider: "local" }),
      query: async () => [],
      drop: async () => {},
      health: async () => true,
      fingerprint: () => fingerprint,
      audit: async () => ({ count: 1, checks: ["manifest", "bytes", "count"] }),
    };
  function add(
    source = "builtin",
    project = "project",
    settings: SearchSettings = { ...DEFAULT_SEARCH_SETTINGS, enabled: true },
  ) {
    if (source !== "builtin" && !sources.list().some((item) => item.id === source))
      sources.save(
        { id: source, name: source, kind: "elasticsearch", connection: "connection", knowledge: null, enabled: true },
        0,
        () => {},
      );
    const scope = { source, owner: "owner", project };
    jobs.configure(scope, settings, 0);
    jobs.complete(
      jobs.claim([source])!,
      {
        text: settings.fulltext
          ? { provider: sources.get(source).kind, name: (source === "builtin" ? "a" : "b").repeat(64) }
          : null,
        vector: settings.vector ? { provider: "milvus", name: "c".repeat(64) } : null,
        analyzer: settings.analyzer,
        source: sources.get(source),
        sourceRevision: 1,
        settingsRevision: 1,
        embedding: settings.vector ? "vector-v1" : null,
        textFingerprint: settings.fulltext ? fingerprint : null,
        ...(settings.vector ? { knowledgeCommit: "knowledge-v1" } : {}),
      },
      head,
      1,
    );
    return scope;
  }
  return {
    db,
    jobs,
    sources,
    audits,
    ports,
    provider,
    add,
    setHead: (value: string) => {
      head = value;
    },
    setFingerprint: (value: string) => {
      fingerprint = value;
    },
  };
}
