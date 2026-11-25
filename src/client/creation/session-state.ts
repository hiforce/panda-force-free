import type { CreationRequest, CreationTaskDetail } from "../../shared/creation/contracts.js";
import type { HarnessRuntimeView } from "../../shared/harness/contracts.js";
import { CreationConversationHistory } from "./activity-conversation.js";
import type { creationSessionRoute } from "./session-route.js";

/** One page-owned model is shared by read and command controllers; views own only DOM state. */
export class CreationSessionState {
  route: ReturnType<typeof creationSessionRoute> = null;
  task?: CreationTaskDetail;
  epoch = 0;
  timer?: ReturnType<typeof setTimeout>;
  reading = false;
  goalWriting = false;
  goalRevision = 0;
  pendingGoal?: import("../../shared/creation/contracts.js").CreationGoalCommand;
  readonly sending = new Set<string>();
  readonly stopping = new Map<string, Promise<void>>();
  updateTarget?: { id: string; generation: number };
  pending?: { id: string; taskId?: string; request: CreationRequest | Record<string, unknown> };
  runtimeId = "";
  runtime?: HarnessRuntimeView;
  runtimePreferenceSaved = false;
  catalogEpoch = 0;
  model = "";
  effort = "";
  readonly conversation = new CreationConversationHistory();
  historyController = new AbortController();
  historyLoading = false;
  historyCheckedAt = 0;
  historyFailed = false;
  readonly previous = new Map<string, { task: CreationTaskDetail; at: number }>();
}
