import type { MetadataStore } from "../metadata-ports.js";
import type { KnowledgeTaskStore } from "../tasks/contracts.js";
import type { KnowledgeReviewStore } from "../review/contracts.js";
import type { KnowledgeCatalog } from "../catalog/contracts.js";
import type { KnowledgeAccessStore } from "../tasks/access.js";
import type {
  KnowledgeGenerationPolicyStore,
  KnowledgeGenerationJobStore,
  KnowledgeGenerationAdmissions,
  KnowledgeGenerationStatusReads,
} from "../generation/contracts.js";
import type { KnowledgeGenerationBudgetLimits } from "../../../shared/knowledge/generation-budget.js";
/** Explicit feature injection selects one persistence owner; file contents and engine state stay outside this port. */
export interface KnowledgePersistence {
  ledger: MetadataStore<KnowledgeTaskStore>;
  reviews: MetadataStore<KnowledgeReviewStore>;
  catalog: MetadataStore<KnowledgeCatalog>;
  access: MetadataStore<KnowledgeAccessStore>;
  generation: {
    policies: MetadataStore<KnowledgeGenerationPolicyStore>;
    queue: MetadataStore<KnowledgeGenerationJobStore>;
    admission: MetadataStore<KnowledgeGenerationAdmissions>;
    status: MetadataStore<KnowledgeGenerationStatusReads>;
    configureBudgets(input: KnowledgeGenerationBudgetLimits): void | Promise<void>;
    auditBudgets(): { repaired: boolean } | Promise<{ repaired: boolean }>;
  };
}
