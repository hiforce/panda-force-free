import type { MessageId, Translate } from "../i18n/messages.js";

/** Public operation names carry no tool arguments, filesystem paths or private reasoning. */
export const creationOperations = {
  panda_creation_context: "creation.progressReadContext",
  panda_creation_goal: "creation.progressReadGoal",
  panda_creation_material_read: "creation.progressReadMaterial",
  panda_creation_original_read: "creation.progressReadOriginal",
  panda_documents_destinations: "creation.progressFindDestination",
  panda_document_file_directory: "creation.progressFindDirectory",
  panda_documents_create: "creation.progressSaveDocument",
  panda_images_render: "creation.progressRenderImage",
  panda_slides_render: "creation.progressRenderSlides",
  panda_slides_edit: "creation.progressEditSlides",
  panda_web_render: "creation.progressRenderWeb",
  panda_videos_render: "creation.progressRenderVideo",
  panda_videos_generate: "creation.progressGenerateVideo",
  panda_artifacts_save: "creation.progressSaveArtifact",
  panda_artifacts_import_file: "creation.progressImportArtifact",
  nativeWork: "creation.progressNativeWork",
  nativeWrite: "creation.progressNativeWrite",
} as const satisfies Record<string, MessageId>;
export type CreationOperation = keyof typeof creationOperations;
export function creationOperation(value: unknown): value is CreationOperation {
  return typeof value === "string" && Object.hasOwn(creationOperations, value);
}
export function creationProgressText(
  event: {
    stage: string;
    operation?: CreationOperation;
    status?: "running" | "completed" | "failed";
  },
  t: Translate,
  active = true,
): string {
  if (event.stage === "activity" && event.operation && event.status) {
    const status = {
      running: "common.inProgress",
      completed: "creation.progressCompleted",
      failed: "creation.progressFailed",
    } as const;
    const observed = event.status === "running" && !active ? "failed" : event.status;
    return t(creationOperations[event.operation]) + " · " + t(status[observed]);
  }
  const stages = {
    preparing: "creation.progressPreparing",
    started: "creation.progressStarted",
    saving: "creation.progressSaving",
    waiting: "creation.progressWaiting",
    answered: "creation.progressAnswered",
  } as const;
  return event.stage in stages ? t(stages[event.stage as keyof typeof stages]) : "";
}
