import { resolve } from "node:path";
import { createAutoContinueRecovery } from "../bridge/auto-continue.js";
import { createQueueRecovery } from "../bridge/message-queue.js";
import { readSharedRecoveryState } from "../bridge/shared-input.js";
import { GoalStore, goalNotification } from "../conversation/goal-store.js";
import { createThreadHub } from "../conversation/thread-hub.js";
import { readComposerHistory } from "../conversation/composer-history.js";
import type { InstalledEngine, ReviewRecorder } from "./runtime-contract.js";
import type { CodexConnection } from "./codex-transport.js";
import { createCodexDriver } from "./codex.js";
import { createEngineRegistry } from "./registry.js";
import { createEngineRpc } from "./rpc-compat.js";

/** Installed providers own native history, recovery and extension stores behind runtime ports. */
export function createInstalledEngine({
  id,
  connection,
  defaultCwd,
  home,
  version,
  sessionsRoot,
  reviewDiffs,
  isShuttingDown,
  authorize,
  broadcast,
}: {
  id: string;
  connection: CodexConnection;
  defaultCwd: string;
  home: string;
  version: string;
  sessionsRoot: string;
  reviewDiffs: ReviewRecorder;
  isShuttingDown(): boolean;
  authorize(): void;
  broadcast(data: object): void;
}): InstalledEngine {
  const registry = createEngineRegistry();
  registry.register(createCodexDriver({ connection, defaultCwd, version, isShuttingDown }));
  const driver = registry.select(id);
  const rpc = createEngineRpc(driver);
  const request = (method: string, params: Record<string, unknown> = {}) => {
    authorize();
    return rpc(method, params);
  };
  const history = createThreadHub({
    request,
    reviewDiffs,
    sharedMode: connection.mode === "shared",
    defaultSessionsRoot: sessionsRoot,
  });
  driver.subscribe((event) => {
    if (event.kind === "connected" && event.storage?.sessionsRoot) history.setSessionsRoot(event.storage.sessionsRoot);
  });
  const recoveryRequest = (method: string, params: Record<string, unknown> = {}) =>
    connection.mode === "shared" && method === "thread/read"
      ? readSharedRecoveryState(request, params.threadId)
      : request(method, params);
  return {
    driver,
    request,
    history: {
      ...history,
      readComposerHistory: (options) => readComposerHistory(resolve(history.sessionsRoot, ".."), options),
    },
    goals: new GoalStore({
      home,
      onChange: (goal) => {
        const payload = goalNotification(goal);
        if (payload) broadcast({ type: "engine/notification", payload });
      },
    }),
    recovery: createAutoContinueRecovery(recoveryRequest, (error: Error) =>
      console.error("[PandaForce] engine/recovery", error.message),
    ),
    recoverQueue: createQueueRecovery(recoveryRequest, (error: Error) =>
      console.error("[PandaForce] engine/queue-recovery", error.message),
    ),
  };
}
