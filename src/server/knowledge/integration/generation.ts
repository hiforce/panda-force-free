import type { KnowledgePersistence } from "../storage/persistence.js";
import type { MetadataStore } from "../metadata-ports.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import type { Database } from "bun:sqlite";
import type { DocumentProjectReads } from "../../documents/files/projects.js";
import type { KnowledgeReadScope } from "../catalog/contracts.js";
import type { KnowledgeContent, KnowledgeTaskStore } from "../tasks/contracts.js";
import type { KnowledgeTasks } from "../tasks/service.js";
import type { KnowledgeRunner } from "../tasks/runner.js";
import { KnowledgeGenerationPolicies } from "../storage/generation-policies.js";
import { KnowledgeGenerationQueue } from "../storage/generation-queue.js";
import { KnowledgeGenerationAdmission } from "../storage/generation-admission.js";
import { KnowledgeGenerationSettings } from "../generation/service.js";
import { KnowledgeGenerationWorker } from "../generation/worker.js";
import { KnowledgeGenerationDiscovery } from "../generation/discovery.js";
import { KnowledgeGenerationSubmission } from "../generation/submission.js";
import { fileKnowledgeGenerationSource } from "./generation-content.js";
import { KnowledgeGenerationStatusStore } from "../storage/generation-status.js";
import type { KnowledgeGenerationBudgetLimits } from "../../../shared/knowledge/generation-budget.js";
import { configureGenerationBudgets } from "../storage/generation-budget.js";
import { auditGenerationBudgets } from "../storage/generation-budget-audit.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";

/** Only the enclosing feature owns the shared database; this assembly adds no global scheduler or engine. */
export function createKnowledgeGeneration(options: {
  db: Database | null;
  storage?: KnowledgePersistence["generation"];
  tasks: KnowledgeTasks;
  ledger: MetadataStore<KnowledgeTaskStore>;
  runner: KnowledgeRunner;
  documents(scope: KnowledgeReadScope): Promise<DocumentProjectReads>;
  originals?(scope: KnowledgeReadScope): Promise<FileOriginalQueries>;
  initializeDocuments?(scope: KnowledgeReadScope): Promise<void>;
  generationBudget?: KnowledgeGenerationBudgetLimits;
  content: KnowledgeContent;
  available(): boolean;
  report(error: unknown): void;
}) {
  const initialize = options.generationBudget
    ? options.storage
      ? Promise.resolve(options.storage.configureBudgets(options.generationBudget))
      : (configureGenerationBudgets(options.db!, options.generationBudget), Promise.resolve())
    : Promise.resolve();
  let budgetHealthy = false,
    nextBudgetCheck = 0,
    checking: Promise<boolean> | undefined;
  const maintainBudget = (): Promise<boolean> => {
    if (checking) return checking;
    if (Date.now() < nextBudgetCheck) return Promise.resolve(budgetHealthy);
    checking = (async () => {
      budgetHealthy = false;
      nextBudgetCheck = Date.now() + 60000;
      try {
        await initialize;
        if (options.storage) await options.storage.auditBudgets();
        else auditGenerationBudgets(options.db!);
        budgetHealthy = true;
        nextBudgetCheck = Date.now() + 300000;
      } catch (error) {
        options.report(error);
      }
      return budgetHealthy;
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  };
  void maintainBudget();
  const source = fileKnowledgeGenerationSource(
      (owner, project) => options.documents({ owner, project }),
      options.initializeDocuments ? (owner, project) => options.initializeDocuments!({ owner, project }) : undefined,
      options.originals ? (owner, project) => options.originals!({ owner, project }) : undefined,
    ),
    policies =
      options.storage?.policies ?? new KnowledgeGenerationPolicies(options.db!, options.ledger as KnowledgeTaskStore),
    queue = options.storage?.queue ?? new KnowledgeGenerationQueue(options.db!, options.ledger as KnowledgeTaskStore),
    admission = options.storage?.admission ?? new KnowledgeGenerationAdmission(options.db!),
    discovery = new KnowledgeGenerationDiscovery(policies, queue, source, options.runner, options.report),
    submission = new KnowledgeGenerationSubmission(
      policies,
      queue,
      admission,
      source,
      options.tasks,
      options.available,
    ),
    worker = new KnowledgeGenerationWorker(discovery, submission, options.available, options.report, maintainBudget),
    status = options.storage?.status ?? new KnowledgeGenerationStatusStore(options.db!),
    settings = new KnowledgeGenerationSettings(
      policies,
      source,
      options.content,
      {
        interrupt: options.runner.interrupt.bind(options.runner),
        wake: worker.wake.bind(worker),
      },
      Date.now,
      {
        catalog: source,
        status: {
          async status(owner, project, now) {
            await maintainBudget();
            if (!budgetHealthy) throw new KnowledgeTaskError("unavailable");
            return status.status(owner, project, now);
          },
        },
      },
    );
  return {
    settings,
    worker,
    async close() {
      await worker.close();
      await checking;
    },
  };
}
