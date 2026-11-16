import type { BuildRun } from "../shared/builds/run.js";
import type { MessageId } from "../shared/i18n/messages.js";

export const phaseLabels: Record<BuildRun["phase"], MessageId> = {
  queued: "builds.queued",
  resolving: "builds.resolving",
  running: "builds.running",
  collecting: "builds.collecting",
  completed: "builds.completed",
  failed: "builds.failed",
  cancelling: "builds.cancelling",
  cancelled: "builds.cancelled",
};
