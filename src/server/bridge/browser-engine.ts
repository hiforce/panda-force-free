import { isRecord } from "../../shared/records.js";
import { isAllowedBrowserRpcMethod } from "../auth/security.js";
import { publishCatalogUpdate } from "../projects/publish.js";
import { browserEnvelope } from "../protocol/browser.js";
import { threadFromResult } from "../protocol/native.js";
import type { RuntimeServices } from "./../services.js";
import { createBrowserDispatch } from "./browser-dispatch.js";
import { prepareSharedInput, submitPreparedInput } from "./shared-input.js";
import { ProjectError } from "../projects/catalog.js";

/** Composes browser RPC handlers without owning the native connection or its storage. */
export function createBrowserEngine({
  sendRaw,
  attachmentStorage,
  defaultCwd,
  presentBrowserData,
  appServerConnection,
  projectVisibility,
  projectCatalog,
  projectWorkspaces,
  directoryPolicy,
  goalStore,
  pendingEngineRequests,
  autoContinueRecovery,
  recoverMessageQueue,
  threadHub,
  request: nativeRequest,
  broadcast,
}: Pick<
  RuntimeServices,
  | "sendRaw"
  | "attachmentStorage"
  | "defaultCwd"
  | "presentBrowserData"
  | "appServerConnection"
  | "projectVisibility"
  | "projectCatalog"
  | "projectWorkspaces"
  | "directoryPolicy"
  | "goalStore"
  | "pendingEngineRequests"
  | "autoContinueRecovery"
  | "recoverMessageQueue"
  | "threadHub"
  | "request"
  | "broadcast"
>) {
  const request: RuntimeServices["request"] = async (method, params) =>
    directoryPolicy.list(method, await nativeRequest(method, params), (id) => threadHub.getThreadMetadata(id));
  const browserDispatch = createBrowserDispatch({
    isAllowedMethod: isAllowedBrowserRpcMethod,
    request,
    pendingServerRequests: pendingEngineRequests,
    sendRaw,
    broadcast,
  });
  browserDispatch.before(({ method, params, flags }) =>
    directoryPolicy.allowExternal
      ? undefined
      : directoryPolicy.assertRequest(method, params, flags, (id) => threadHub.getThreadMetadata(id)),
  );
  browserDispatch.resolve("thread/start", async ({ params, flags }) => {
    if (flags.pandaProjectId === undefined) return undefined;
    if (typeof flags.pandaProjectId !== "string" || !flags.pandaProjectId)
      throw new ProjectError(400, "projects.errorInvalidProjectDetails");
    const workspace = await projectWorkspaces.ensure(flags.pandaProjectId);
    params.cwd = workspace.path;
    return request("thread/start", params);
  });
  browserDispatch.before(({ method, params }) => {
    if (method === "thread/list" && appServerConnection.mode === "shared") params.useStateDbOnly = true;
  });
  // Any explicit turn supersedes a pending automatic recovery and starts a
  // fresh retry budget for this thread.
  browserDispatch.before(({ method, params }) => {
    if (["turn/start", "turn/steer"].includes(method)) autoContinueRecovery.onExplicitInput(params.threadId);
  });
  browserDispatch.handle("thread/goal/set", async ({ params }) => {
    if (typeof params.threadId !== "string" || !params.threadId) throw new Error("Invalid goal thread id");
    if (
      params.objective !== undefined &&
      (typeof params.objective !== "string" || !params.objective.trim() || params.objective.length > 4000)
    )
      throw new Error("Goal objective must contain 1 to 4000 characters");
    if (params.objective === undefined && typeof params.status !== "string")
      throw new Error("Goal update requires an objective or status");
    // The editor changes only the objective; lifecycle and budgets remain
    // under Codex ownership. Native mutation provenance reflects a Save click.
    const nativeParams = {
      threadId: params.threadId,
      origin: "user",
      ...(params.objective === undefined ? { status: params.status } : { objective: params.objective.trim() }),
    };
    const result = await request("thread/goal/set", nativeParams);
    goalStore.refresh();
    return result;
  });
  browserDispatch.resolve("host/thread/history", ({ params }) => threadHub.readConversationHistory(params));
  browserDispatch.resolve("thread/read", ({ params }) =>
    appServerConnection.mode === "shared" ? threadHub.readBrowserThread(params) : undefined,
  );
  browserDispatch.resolve("thread/turns/list", ({ params }) =>
    appServerConnection.mode === "shared" && params.itemsView === "full"
      ? threadHub.readBrowserTurns(params)
      : undefined,
  );
  browserDispatch.resolve("host/thread/live", ({ params }) => threadHub.readLiveThread(params.threadId));
  browserDispatch.resolve("thread/resume", ({ params, flags }) =>
    appServerConnection.mode === "shared" && (flags.pandaPrepareInput === true || params.excludeTurns === true)
      ? prepareSharedInput({ request, getThreadMetadata: threadHub.getThreadMetadata }, params)
      : undefined,
  );
  // Prepare on this connection before dispatching input, without an extra browser round trip.
  for (const method of ["turn/start", "turn/steer"])
    browserDispatch.resolve(method, ({ params, flags }) => {
      if (flags.pandaPrepareInput !== true) return undefined;
      return submitPreparedInput(
        {
          request,
          getThreadMetadata: threadHub.getThreadMetadata,
          recordPrepared: threadHub.recordThreadPathsFromRpc,
          markSubscribed: threadHub.markSubscribed,
        },
        method,
        params,
      );
    });
  browserDispatch.after(({ method, params }) => {
    if (method === "thread/delete" && params.threadId) threadHub.invalidateHistory(params.threadId);
  });
  browserDispatch.after(({ result }) => {
    const thread = threadFromResult(result);
    if (thread) directoryPolicy.remember(thread);
    threadHub.recordThreadPathsFromRpc(result);
  });
  browserDispatch.after(({ method, flags, result }) => {
    if (method !== "thread/start" || typeof flags.pandaProjectId !== "string") return;
    const thread = threadFromResult(result);
    if (!thread) return;
    // A native creation is already committed. Metadata failure must never look like a retryable creation failure.
    publishCatalogUpdate(projectCatalog, broadcast, () => {
      const snapshot = projectCatalog.assign(
        flags.pandaProjectId as string,
        [thread],
        projectCatalog.snapshot().revision,
      );
      if (isRecord(result)) {
        result.pandaProjectId = flags.pandaProjectId;
        result.pandaProjectCatalog = directoryPolicy.snapshot(snapshot);
      }
      return snapshot;
    });
  });
  browserDispatch.after(({ method, params, result }) => {
    publishCatalogUpdate(projectCatalog, broadcast, () => {
      const snapshot =
        method === "thread/delete" && typeof params.threadId === "string"
          ? projectCatalog.forgetSession(params.threadId)
          : method === "thread/name/set" && typeof params.threadId === "string"
            ? projectCatalog.refreshSessions([{ id: params.threadId, name: params.name }])
            : isRecord(result) && Array.isArray(result.data) && method === "thread/list"
              ? projectCatalog.refreshSessions(result.data)
              : null;
      return snapshot;
    });
  });
  browserDispatch.after(({ method, params, result }) => threadHub.recordReviewDiffsFromRpc(method, params, result));
  // Metadata-only rejoin subscribes an already-loaded thread to live approvals,
  // including when its history is served through bounded native item pages.
  browserDispatch.after(async ({ method, result }) => {
    if (["host/thread/history", "thread/read"].includes(method))
      await threadHub.subscribeSharedThread(threadFromResult(result));
  });
  browserDispatch.after(({ method, params, result }) => {
    if (["host/thread/history", "thread/read"].includes(method))
      goalStore.emit(threadFromResult(result)?.id || params.threadId);
  });
  browserDispatch.after(({ method, result }) => {
    const thread = threadFromResult(result);
    if (
      appServerConnection.mode === "shared" &&
      ["thread/start", "thread/resume"].includes(method) &&
      thread &&
      isRecord(result) &&
      !result.pandaAlreadyLoaded
    )
      threadHub.markSubscribed(thread.id);
  });
  browserDispatch.after(({ method, params, flags, result, replyExtras }) => {
    if (method !== "thread/start") return;
    const thread = threadFromResult(result);
    if (thread && !flags.pandaProjectless) {
      try {
        if (projectVisibility.setHidden(thread.cwd || params.cwd || defaultCwd, false)) {
          broadcast({ type: "projects/visibility", ...projectVisibility.snapshot() });
        }
      } catch (error) {
        // A completed creation must not look like a failed RPC and be retried.
        console.error("[panda-force] could not restore project visibility:", error);
      }
    }
    replyExtras.projectVisibility = directoryPolicy.visibility(projectVisibility.snapshot());
  });
  browserDispatch.after(({ method, params }) => {
    if (["thread/resume", "thread/queue/add", "thread/queue/list"].includes(method))
      void recoverMessageQueue(params.threadId);
  });

  async function dispatchBrowserMessage(input: unknown) {
    let message = browserEnvelope(input);
    if (
      attachmentStorage &&
      ["turn/start", "turn/steer", "thread/queue/add"].includes(message?.method) &&
      Array.isArray(message.params?.input)
    ) {
      message = {
        ...message,
        params: { ...message.params, input: await attachmentStorage.prepareInput(message.params.input) },
      };
    }
    const reply = await browserDispatch.dispatch(message);
    return presentBrowserData(reply);
  }

  return dispatchBrowserMessage;
}
