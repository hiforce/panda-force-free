import type { KnowledgePersistence } from "../storage/persistence.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { KnowledgeTaskInput } from "../../../shared/knowledge/tasks.js";
import type { ApplicationToolEngine } from "../../../shared/engine/application-tools.js";
import type { KnowledgeContent } from "../tasks/contracts.js";
import { openKnowledgeDatabase } from "../storage/database.js";
import { knowledgeTaskLedger } from "../storage/ledger.js";
import { knowledgeTaskFiles } from "./task-files.js";
import { KnowledgeOutputs } from "../tasks/outputs.js";
import { KnowledgeWorker } from "../tasks/worker.js";
import { KnowledgeRunner } from "../tasks/runner.js";
import { KnowledgeTasks } from "../tasks/service.js";
import { knowledgeRoutes } from "./routes.js";
import { knowledgeReviewStore } from "../storage/review-store.js";
import { KnowledgeApprovals } from "../tasks/approvals.js";
import { KnowledgeAutomaticReviewer } from "../review/worker.js";
import { KnowledgeReviewSettings } from "../review/service.js";
import { KnowledgeCatalogStore } from "../storage/catalog.js";
import { KnowledgeCatalogReconciler } from "../catalog/reconcile.js";
import type { KnowledgeReadScope } from "../catalog/contracts.js";
import type { DocumentProjectReads } from "../../documents/files/projects.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import { FileApprovedKnowledgeReader } from "./approved-reader.js";
import { KnowledgeRecords, unavailableApprovedKnowledge } from "../catalog/read.js";
import { knowledgeRecordRoutes } from "./record-routes.js";
import { createKnowledgeGeneration } from "./generation.js";
import { knowledgeGenerationRoutes } from "./generation-routes.js";
import type { KnowledgeGenerationBudgetLimits } from "../../../shared/knowledge/generation-budget.js";
import { KnowledgeAccessAudit } from "../tasks/access.js";
import { KnowledgeAccessScopes } from "../storage/access.js";

/** Web, CLI and rule adapters join the same owner-scoped application; only this composition owns its lifetime. */
export function createKnowledgeFeature(options: {
  stateRoot: string;
  storage?: KnowledgePersistence;
  content: KnowledgeContent;
  profile(): Promise<KnowledgeTaskInput["profile"]>;
  engine(profile: KnowledgeTaskInput["profile"]): ApplicationToolEngine;
  available(): boolean;
  owner(context: RouteContext): string;
  report(error: unknown): void;
  concurrency?: number;
  generationBudget?: KnowledgeGenerationBudgetLimits;
  documents?(scope: KnowledgeReadScope): Promise<DocumentProjectReads>;
  indexDocuments?(scope: KnowledgeReadScope): Promise<DocumentProjectReads>;
  originals?(scope: KnowledgeReadScope): Promise<FileOriginalQueries>;
  indexOriginals?(scope: KnowledgeReadScope): Promise<FileOriginalQueries>;
  generationDocuments?(scope: KnowledgeReadScope): Promise<DocumentProjectReads>;
  initializeDocuments?(scope: KnowledgeReadScope): Promise<void>;
}) {
  const db = options.storage ? null : openKnowledgeDatabase(join(options.stateRoot, "data", "knowledge.sqlite"));
  try {
    const ledger = options.storage?.ledger ?? knowledgeTaskLedger(db!),
      reviews = options.storage?.reviews ?? knowledgeReviewStore(db!),
      files = knowledgeTaskFiles(join(options.stateRoot, "knowledge", "tasks")),
      catalog = options.storage?.catalog ?? new KnowledgeCatalogStore(db!),
      catalogReconciler = new KnowledgeCatalogReconciler(catalog, files, options.content, options.report),
      approved = options.documents
        ? new FileApprovedKnowledgeReader(
            catalog,
            options.documents,
            catalogReconciler.request.bind(catalogReconciler),
            options.originals,
          )
        : unavailableApprovedKnowledge(),
      indexed = options.indexDocuments
        ? new FileApprovedKnowledgeReader(
            catalog,
            options.indexDocuments,
            catalogReconciler.request.bind(catalogReconciler),
            options.indexOriginals,
          )
        : approved,
      records = new KnowledgeRecords(approved),
      outputs = new KnowledgeOutputs(ledger, files, options.content),
      approvals = new KnowledgeApprovals(ledger, files, options.content, outputs, reviews),
      reviewer = new KnowledgeAutomaticReviewer(reviews, files, options.content, options.engine, options.report),
      worker = new KnowledgeWorker(ledger, files, options.content, options.engine, options.report),
      runner = new KnowledgeRunner(
        ledger,
        worker,
        outputs,
        options.available,
        options.report,
        Date.now,
        options.concurrency ?? 1,
        { store: reviews, worker: reviewer, approvals },
      ),
      service = new KnowledgeTasks(ledger, files, options.content, options.profile, outputs, runner, Date.now, reviews),
      reviewSettings = new KnowledgeReviewSettings(reviews, ledger, files, options.content, runner),
      generation = options.documents
        ? createKnowledgeGeneration({
            db,
            storage: options.storage?.generation,
            tasks: service,
            ledger,
            runner,
            documents: options.generationDocuments ?? options.documents,
            initializeDocuments: options.initializeDocuments,
            generationBudget: options.generationBudget,
            originals: options.originals,
            content: options.content,
            available: options.available,
            report: options.report,
          })
        : null;
    const access = new KnowledgeAccessAudit(
      options.storage?.access ?? new KnowledgeAccessScopes(db!),
      options.content,
      runner,
      options.report,
    );
    runner.maintain(() => access.tick());
    let closing: Promise<void> | null = null;
    return {
      service,
      reviewSettings,
      generationSettings: generation?.settings,
      catalog,
      approved,
      indexed,
      records,
      requestCatalog: catalogReconciler.request.bind(catalogReconciler),
      routes: [
        ...knowledgeRoutes(service, { ...options, review: reviewSettings }),
        ...knowledgeRecordRoutes(records, { owner: options.owner, report: options.report }),
        ...(generation ? knowledgeGenerationRoutes(generation.settings, options) : []),
      ],
      start: () => {
        runner.start();
        catalogReconciler.start();
        generation?.worker.start();
      },
      close: () =>
        (closing ??= (async () => {
          await generation?.close();
          await runner.close();
          await catalogReconciler.close();
          db?.close();
        })()),
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}
