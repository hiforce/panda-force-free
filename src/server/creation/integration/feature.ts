import type { CreationSubmissionTasks } from "../submissions.js";
import type { CreationOutputTasks } from "../ports.js";
import type { CreationManagement, CreationHistory } from "../service.js";
import type { CreationRunTasks, CreationScheduling } from "../runtime/contracts.js";
import type { CreationQuestionStore } from "../questions/contracts.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { CreationDocumentPort } from "./document-port.js";
import type { SkillCatalog } from "../../skills/catalog/service.js";
import { createSkillSummaryReader } from "../../skills/catalog/summaries.js";
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
import { SQLiteCreationGoals } from "../storage/goals.js";
import type { CreationGoalStore } from "../goals/contracts.js";
import { SQLiteCreationMessages } from "../storage/messages.js";
import { FileCreationMessages } from "./message-files.js";
import { CreationMessages } from "../messages/service.js";
import type { CreationMessageStore } from "../messages/contracts.js";
import { FileCreationWorkspaces } from "./conversation-workspaces.js";
import { CreationSavedArtifacts } from "./saved-artifacts.js";
import { CreationWorkspaceOutput } from "./workspace-output.js";
import { archivedCreationOutput } from "./archived-output.js";
import { TypedCreationOutput } from "./typed-output.js";
import { FileCreationMediaOutput, type CreationAssetAccess } from "./media-output.js";
import { creationImageTools } from "./image-tools.js";
import { CreationError } from "../contracts.js";
import { creationCaptureCapabilities } from "./capabilities.js";

/** This composition owns its database and files. Documents, skills, auth and engine adapters keep their own lifetimes. */
export function createCreationFeature(options: {
  stateRoot: string;
  workspaceRoot?: string;
  owner(context: RouteContext): string;
  authorize(owner: string, projectId: string): Promise<void>;
  documents: CreationDocumentPort;
  archive?: import("./document-archive.js").CreationDocumentArchive;
  destinations?: import("../document-destinations.js").CreationDocumentDestinations;
  directories?: import("../file-directories.js").CreationFileDirectories;
  skills: SkillCatalog;
  profiles: CreationProfiles;
  engines: CreationEngines;
  materials?: import("../materials.js").CreationMaterialPort;
  image?: {
    journal: import("./rendering/image-journal.js").ImageRenderJournal;
    renderer: Parameters<typeof creationImageTools>[0]["renderer"];
    assets: CreationAssetAccess;
    available(): Promise<boolean>;
    generated?: import("./rendering/generated-originals.js").CreationGeneratedOriginals;
    generators?: readonly import("./rendering/generators.js").CreationArtifactGenerator[];
  };
  concurrency?: number;
  storage?: {
    tasks: CreationSubmissionTasks & CreationOutputTasks & CreationManagement & CreationRunTasks;
    queue: CreationScheduling & CreationHistory;
    questions: CreationQuestionStore;
    progress?: CreationProgressStore;
    messages?: CreationMessageStore;
    goals?: CreationGoalStore;
    close?(): void | Promise<void>;
  };
}) {
  const root = join(options.stateRoot, "creation"),
    db = options.storage ? null : openCreationDatabase(join(root, "tasks.sqlite"));
  try {
    const tasks = options.storage?.tasks ?? new CreationTaskRepository(db!),
      queue = options.storage?.queue ?? new CreationQueue(db!, tasks as CreationTaskRepository),
      workspaces = new FileCreationWorkspaces(
        options.workspaceRoot ?? join(root, "working"),
        join(root, "workspace-bindings"),
        tasks,
        options.authorize,
      ),
      inputs = new FileCreationInputs(join(root, "inputs")),
      questionFiles = new FileCreationQuestions(join(root, "questions")),
      questions = new CreationQuestions(
        options.storage?.questions ?? new CreationQuestionRepository(db!, tasks as CreationTaskRepository),
        questionFiles,
        options.authorize,
      ),
      documents = new FileCreationDocumentOutput(
        join(root, "outputs"),
        options.documents,
        true,
        inputs,
        tasks,
        options.archive,
      ),
      progress = options.storage?.progress ?? (db ? new SQLiteCreationProgress(db) : undefined),
      goals =
        options.storage?.goals ??
        (db ? new SQLiteCreationGoals(db, tasks as CreationTaskRepository, queue as CreationQueue) : undefined),
      messageStore = options.storage?.messages ?? (db ? new SQLiteCreationMessages(db) : undefined),
      messages = messageStore
        ? new CreationMessages(
            new FileCreationMessages(join(root, "messages")),
            messageStore,
            tasks,
            inputs,
            async (owner, request, requestDigest) => {
              const capabilities = new Set(
                creationCaptureCapabilities(
                  request.outputType,
                  options.image
                    ? [
                        ...((await options.image.available()) ? ["image" as const] : []),
                        ...(options.image.generators?.map((g) => g.kind) ?? []),
                      ]
                    : [],
                ),
              );
              return request.selections.length
                ? options.skills.capture(
                    { id: request.id, requestBinding: requestDigest, selections: request.selections },
                    owner,
                    {
                      outputType: request.outputType && request.outputType !== "auto" ? request.outputType : "document",
                      ...(request.outputType === undefined ? {} : { guidanceOnly: true }),
                      available: capabilities,
                      granted: capabilities,
                      entitled: new Set(),
                      workflowRequired: false,
                    },
                  )
                : null;
            },
            options.authorize,
            options.materials,
          )
        : undefined,
      savedArtifacts = new CreationSavedArtifacts(join(root, "saved-artifacts"), documents, options.authorize),
      workspaceOutput = new CreationWorkspaceOutput(
        join(root, "exports"),
        documents,
        savedArtifacts,
        workspaces,
        inputs,
        tasks,
        options.documents.images,
        options.directories,
      ),
      archivedOutput = archivedCreationOutput(workspaceOutput, documents, options.archive),
      mediaOutput = options.image
        ? new FileCreationMediaOutput(
            join(root, "media-outputs"),
            options.image.journal,
            options.image.assets,
            options.image.generated,
          )
        : undefined,
      mediaSaved = mediaOutput
        ? new CreationSavedArtifacts(join(root, "saved-artifacts"), mediaOutput, options.authorize)
        : undefined,
      output = mediaOutput
        ? new TypedCreationOutput(join(root, "output-routes"), archivedOutput, {
            stage: (value, task) => mediaOutput.stage(value, task),
            commit: (task, digest) => mediaSaved!.commit(task, digest),
          })
        : archivedOutput,
      outputs = new CreationOutputs(tasks, output, output),
      rendering = options.image
        ? creationImageTools({ ...options.image, outputs, tasks, materials: options.materials, messages })
        : undefined,
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
        messages,
        options.materials,
        goals,
        workspaces,
        options.destinations,
        options.directories,
        rendering,
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
      access = creationAuthority({
        ...options,
        rendering,
        original: options.image
          ? async (owner, artifact) => {
              const source = await (
                await options.image!.assets(owner, artifact.projectId)
              ).original(artifact.projectId, artifact.assetId);
              if (
                source.asset.id !== artifact.assetId ||
                source.asset.kind !== artifact.kind ||
                source.asset.project !== artifact.projectId
              )
                throw new CreationError("notFound");
              return {
                ...artifact,
                version: source.asset.version,
                commit: source.commit,
                title: source.asset.title,
                source: source.asset.source,
              };
            }
          : undefined,
      }),
      submissions = new CreationSubmissions(
        tasks,
        inputs,
        access.authority,
        Date.now,
        options.materials,
        messages,
        (owner, id) => savedArtifacts.read(owner, id),
        (owner, id) => progress?.list(owner, id) ?? [],
      ),
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
        messages,
        createSkillSummaryReader(options.skills),
        goals,
        workspaces,
        options.documents.location,
        (owner, id) => savedArtifacts.read(owner, id),
        (task) => workspaceOutput.location(task),
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
