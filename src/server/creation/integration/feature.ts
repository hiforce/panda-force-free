import type { CreationSubmissionTasks } from "../submissions.js";
import type { CreationOutputTasks } from "../ports.js";
import type { CreationManagement, CreationHistory } from "../service.js";
import type { CreationRunTasks, CreationScheduling } from "../runtime/contracts.js";
import type { CreationQuestionStore } from "../questions/contracts.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { CreationDocumentPort } from "./document-port.js";
import type { SkillCatalog } from "../../skills/catalog/service.js";
import type { CreationEngines } from "../runtime/contracts.js";
import type { CreationProfiles } from "./profiles.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { openCreationDatabase } from "../storage/database.js";
import { CreationTaskRepository } from "../storage/repository.js";
import { CreationQueue } from "../storage/queue.js";
import { CreationQuestionRepository } from "../storage/questions.js";
import { CreationQuestions } from "../questions/service.js";
import { FileCreationInputs } from "./input-codec.js";
import { FileCreationQuestions } from "./question-files.js";
import { FileCreationDocumentOutput } from "./document-output.js";
import { CreationOutputs } from "../outputs.js";
import { CreationSubmissions } from "../submissions.js";
import { CreationWorker } from "../runtime/worker.js";
import { CreationRunner } from "../runtime/runner.js";
import { CreationService } from "../service.js";
import { creationAuthority } from "./authority.js";
import { creationRoutes } from "./routes.js";
import { SQLiteCreationProgress } from "../storage/progress.js";
import type { CreationProgressStore } from "../ports.js";

/** This composition owns its database and files. Documents, skills, auth and engine adapters keep their own lifetimes. */
export function createCreationFeature(options: {
  stateRoot: string;
  owner(context: RouteContext): string;
  authorize(owner: string, projectId: string): Promise<void>;
  documents: CreationDocumentPort;
  skills: SkillCatalog;
  profiles: CreationProfiles;
  engines: CreationEngines;
  concurrency?: number;
  storage?: {
    tasks: CreationSubmissionTasks & CreationOutputTasks & CreationManagement & CreationRunTasks;
    queue: CreationScheduling & CreationHistory;
    questions: CreationQuestionStore;
    progress?: CreationProgressStore;
    close?(): void | Promise<void>;
  };
}) {
  const root = join(options.stateRoot, "creation"),
    db = options.storage ? null : openCreationDatabase(join(root, "tasks.sqlite"));
  try {
    const tasks = options.storage?.tasks ?? new CreationTaskRepository(db!),
      queue = options.storage?.queue ?? new CreationQueue(db!, tasks as CreationTaskRepository),
      inputs = new FileCreationInputs(join(root, "inputs")),
      questionFiles = new FileCreationQuestions(join(root, "questions")),
      questions = new CreationQuestions(
        options.storage?.questions ?? new CreationQuestionRepository(db!, tasks as CreationTaskRepository),
        questionFiles,
        options.authorize,
      ),
      documents = new FileCreationDocumentOutput(join(root, "outputs"), options.documents, true),
      progress = options.storage?.progress ?? (db ? new SQLiteCreationProgress(db) : undefined),
      outputs = new CreationOutputs(tasks, documents, documents),
      worker = new CreationWorker(
        tasks,
        queue,
        inputs,
        outputs,
        questions,
        options.engines,
        options.authorize,
        Date.now,
        30000,
        (error) => reportDiagnostic("creation-engine", error),
        progress,
      ),
      runner = new CreationRunner(
        queue,
        worker,
        outputs,
        (stage, error) => reportDiagnostic("creation-" + stage, error),
        Date.now,
        options.concurrency ?? 2,
        () => options.profiles.settings.enabled,
      ),
      access = creationAuthority(options),
      submissions = new CreationSubmissions(tasks, inputs, access.authority, Date.now, documents),
      service = new CreationService(
        tasks,
        queue,
        submissions,
        inputs,
        questions,
        options.authorize,
        access.availability,
        runner,
        Date.now,
        progress,
      );
    let closing: Promise<void> | null = null;
    return {
      service,
      routes: creationRoutes(service, options.owner),
      start: () => runner.start(),
      close: () =>
        (closing ??= (async () => {
          await Promise.all([service.close(), runner.stop()]);
          await outputs.drain();
          if (options.storage) await options.storage.close?.();
          else db!.close();
        })()),
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}
