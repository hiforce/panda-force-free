import type { MetadataStore } from "../../knowledge/metadata-ports.js";
import type { SearchSourceRegistry } from "./registry.js";
import type { SearchJobs } from "./jobs.js";
import type { SearchProjectPolicies } from "./project-policies.js";
import type { AnalyzerStore } from "../analyzers/store.js";
import type { SearchConnections } from "../integration/connections.js";
import type { IndexResourceRegistry } from "../resources/contracts.js";
import type { ResourceScanStore } from "../resources/scan-contracts.js";
import type { SearchAuditPersistence } from "./ports.js";
import type { EmbeddingBudget } from "../embeddings/budget.js";
import type { EmbeddingPolicy } from "../embeddings/policy.js";
/** Business metadata selects one relational owner. Derived text indexes, vector seals and binary analyzer/cache files stay local. */
export interface SearchPersistence {
  sources: MetadataStore<SearchSourceRegistry>;
  jobs: MetadataStore<SearchJobs>;
  policies: MetadataStore<SearchProjectPolicies>;
  analyzers: MetadataStore<AnalyzerStore>;
  connections: MetadataStore<SearchConnections>;
  resources: MetadataStore<IndexResourceRegistry>;
  audits: SearchAuditPersistence;
  scans: MetadataStore<ResourceScanStore>;
  instance: string;
  embeddingBudget(policy: EmbeddingPolicy, now: () => number): MetadataStore<EmbeddingBudget>;
}
