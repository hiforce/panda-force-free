/**
 * HTTP/WS composition root. Authenticate before routing workspace operations.
 * Shared mode attaches to the host daemon without owning its process lifetime;
 * shutdown closes this service's clients and workers, never the shared daemon.
 * Persistent application metadata, model state and workspace files have distinct
 * storage owners; do not clear one as a shortcut for resetting another.
 */
import { gzipSync } from "node:zlib";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { isDirectory, listFolders, resolveBrowsePath } from "./workspace/folders.js";
import { applyReviewPatch } from "./review/apply.js";
import { ReviewDiffStore, parseReviewPatchRequest } from "./review/state.js";
import { rpcErrorPayload } from "../shared/bridge-errors.js";
import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from "./terminal/session.js";
import { readWorkspaceContext } from "./workspace/context.js";
import { searchWorkspaceFiles } from "./workspace/search.js";
import { listWorkspaceEntries } from "./workspace/entries.js";
import { readGitDiff, readGitHistory, readGitStatus } from "./workspace/git.js";
import { resolveLocalFile } from "./workspace/files.js";
import { resolveLocalImage } from "./workspace/images.js";
import { createImageThumbnailCache } from "./workspace/image-thumbnails.js";
import { createLocalImagePresenter } from "./workspace/image-presentation.js";
import { resolveAppServerConnection } from "./bridge/app-server-connection.js";
import { createCodexBridge } from "./bridge/codex-process.js";
import { createBrowserDispatch } from "./bridge/browser-dispatch.js";
import { createThreadHub } from "./conversation/thread-hub.js";
import { createQueueRecovery } from "./bridge/message-queue.js";
import { createAutoContinueRecovery } from "./bridge/auto-continue.js";
import { createNotificationRegistry } from "./bridge/notifications.js";
import { notifyNtfyTurnCompleted } from "./misc/ntfy.js";
import { prepareSharedInput, readSharedRecoveryState } from "./bridge/shared-input.js";
import { serveStaticAsset } from "./http/static-assets.js";
import { respondError, respondJson, respondMethodNotAllowed } from "./http/respond.js";
import { readComposerHistory } from "./conversation/composer-history.js";
import { ProjectVisibilityStore } from "./misc/project-visibility.js";
import { ProjectCatalog } from "./projects/catalog.js";
import { projectRoutes } from "./projects/routes.js";
import { GoalStore, goalNotification } from "./conversation/goal-store.js";
import { saveAttachment } from "./workspace/attachments.js";
import { createOssAttachmentStorage, readOssAttachmentConfig } from "./workspace/oss-attachments.js";
import { config, assertStartupAuth } from "./config.js";
import { createAuthState } from "./auth/state.js";
import { createPasswordAuth } from "./auth/routes.js";
import { readJsonBody } from "./http/body.js";
import { createRouter } from "./http/router.js";
import { createIdaasAuth, readIdaasConfig, AuthError } from "./auth/idaas.js";
import { sessionLoginUrl } from "../shared/auth-return-path.js";
import {
  isAllowedBrowserRpcMethod,
  resolvePublicAsset,
  resolveSafeRegularFile,
  unauthorizedResponse,
} from "./auth/security.js";
import {
  createAccountIdentityLoader,
  fetchProfileAvatar,
  resolveAccountIdentity,
  toPublicAccountIdentity,
} from "./misc/profile.js";

const idaasConfig = readIdaasConfig();
const idaasAuth = idaasConfig ? createIdaasAuth(idaasConfig) : null;
const attachmentStorage = createOssAttachmentStorage(readOssAttachmentConfig());
const imageThumbnail = createImageThumbnailCache();
const {
  host,
  port,
  localhostOnly,
  appRoot,
  publicDir,
  homeDir,
  projectless,
  defaultCwd,
  browseRoots,
  attachmentRoot,
  imageRoots,
  fileRoots,
  reviewRoots,
} = config;
const presentLocalImages = createLocalImagePresenter({ cwd: defaultCwd, home: homeDir, allowedRoots: imageRoots });
function presentBrowserData(value: any) {
  return presentLocalImages(attachmentStorage ? attachmentStorage.present(value) : value);
}
const authState = createAuthState({
  environmentPassword: config.environmentPassword,
  accessToken: config.accessToken,
  managedPasswordDisabled: Boolean(idaasAuth || config.authMode === "none"),
});
assertStartupAuth({ idaasEnabled: Boolean(idaasAuth) });
const passwordAuth = createPasswordAuth({ authState });
// Keep the selected backend across reconnects; silently switching to another
// writer after a daemon disconnect would break shared sessions.
const appServerConnection = resolveAppServerConnection(process.env, homeDir);
console.info(
  "[PandaForce] Native engine connection",
  JSON.stringify({ mode: appServerConnection.mode, cwd: defaultCwd }),
);
const projectVisibility = new ProjectVisibilityStore(config.projectVisibilityPath, homeDir);
const projectCatalog = new ProjectCatalog(config.projectCatalogPath);
const goalStore = new GoalStore({
  home: homeDir,
  onChange: (goal) => {
    const notification = goalNotification(goal);
    if (notification) broadcast({ type: "codex/notification", payload: notification });
  },
});
const clients = new Set<WebSocket>();
const sseClients = new Set<ServerResponse>();
const terminalSessions = new Map<WebSocket, ReturnType<typeof createTerminalSession>>();
const pendingCodexRequests = new Map<number | string, any>();
const autoContinueRecovery = createAutoContinueRecovery(recoveryRequest, (error: Error) => {
  console.error("[panda-force] automatic continue failed:", error.message);
});
const reviewDiffs = new ReviewDiffStore();
const recoverMessageQueue = createQueueRecovery(recoveryRequest, (error: Error) => {
  console.error("[panda-force] queue recovery:", error.message);
});
const threadHub = createThreadHub({
  request,
  reviewDiffs,
  sharedMode: appServerConnection.mode === "shared",
  defaultSessionsRoot: config.defaultCodexSessionsRoot,
});
let shuttingDown = false;
let httpClosed = false;
const accountLoader = createAccountIdentityLoader(async (refresh) => {
  const account = await request("account/read", { refreshToken: refresh });
  return resolveAccountIdentity(account);
});
const codexBridge = createCodexBridge({
  connection: appServerConnection,
  defaultCwd,
  clientInfo: { name: "panda-force", title: "PandaForce", version: config.version },
  isShuttingDown: () => shuttingDown,
  onMessage: handleCodexMessage,
  onConnected: (info) => {
    if (typeof info?.codexHome === "string") threadHub.setSessionsRoot(resolve(info.codexHome, "sessions"));
    broadcast({ type: "bridge/status", status: "connected", info });
  },
  onDisconnected: (code, signal) => {
    accountLoader.invalidate();
    reviewDiffs.clear();
    threadHub.clearHistory();
    pendingCodexRequests.clear();
    threadHub.clearSubscriptions();
    broadcast({ type: "bridge/status", status: "disconnected", code, signal });
    if (shuttingDown) maybeFinishShutdown();
  },
});

async function request(method: string, params: any = {}) {
  const result = await codexBridge.request(method, params);
  return presentBrowserData(result);
}

function sendRaw(message: any) {
  codexBridge.sendRaw(message);
}

function maybeFinishShutdown() {
  if (shuttingDown && httpClosed && codexBridge.fullyStopped()) process.exit(0);
}

function recoveryRequest(method: string, params: any = {}) {
  if (appServerConnection.mode === "shared" && method === "thread/read")
    return readSharedRecoveryState(request, params.threadId);
  return request(method, params);
}

function userMessageText(item: any): string {
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return "";
  return item.content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function scheduleGoalCommand(threadId: unknown, item: any) {
  if (typeof threadId !== "string" || !threadId) return;
  const text = userMessageText(item).toLowerCase();
  if (text === "/goal resume") {
    void request("thread/goal/set", { threadId, status: "active", origin: "user" }).catch((error) =>
      console.error("[panda-force] goal resume sync failed:", error instanceof Error ? error.message : error),
    );
  } else if (text === "/goal pause") {
    void request("thread/goal/set", { threadId, status: "paused", origin: "user" }).catch((error) =>
      console.error("[panda-force] goal pause sync failed:", error instanceof Error ? error.message : error),
    );
  } else if (text === "/goal clear") {
    void request("thread/goal/clear", { threadId, origin: "user" }).catch((error) =>
      console.error("[panda-force] goal clear sync failed:", error instanceof Error ? error.message : error),
    );
  }
}

const notifications = createNotificationRegistry();
notifications.onAny((message) => autoContinueRecovery.onNotification(message));
notifications.onAny((message) => {
  if (message.params?.threadId) threadHub.invalidateHistory(message.params.threadId);
});
notifications.on(["item/started", "item/completed"], (params) => scheduleGoalCommand(params.threadId, params.item));
notifications.on(["thread/closed", "thread/deleted"], (params) => threadHub.dropSubscription(params.threadId));
notifications.on("thread/status/changed", (params) => threadHub.recordThreadStatus(params.threadId, params.status));
notifications.on("serverRequest/resolved", (params) => pendingCodexRequests.delete(params.requestId));
notifications.on("account/updated", () => accountLoader.invalidate());
notifications.on("thread/name/updated", (params) => {
  try {
    const snapshot = projectCatalog.refreshSessions([{ id: params.threadId, name: params.threadName || params.name }]);
    if (snapshot) broadcast({ type: "project-catalog/changed", ...snapshot });
  } catch (error) {
    console.warn(
      "[panda-force] project session title update failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
});
notifications.on("turn/diff/updated", (params) => reviewDiffs.record(params));
notifications.on("item/fileChange/patchUpdated", (params) => threadHub.recordFileChangeDiff(params));
notifications.on("item/completed", (params) => {
  if (params.item?.type === "fileChange") threadHub.recordFileChangeDiff({ ...params, changes: params.item.changes });
});
notifications.on("turn/completed", (params) => {
  void notifyNtfyTurnCompleted(params);
  void recoverMessageQueue(params.threadId);
});

function handleCodexMessage(message: any) {
  message = presentBrowserData(message);
  if (message.id !== undefined && message.method) {
    pendingCodexRequests.set(message.id, message);
    broadcast({ type: "codex/request", payload: message });
    return;
  }
  if (message.method) {
    notifications.dispatch(message);
    // Keep the server receive time explicit and timezone-safe for browser clients.
    // Native app-server timestamps are Unix seconds; this ISO value is only the
    // fallback for events that do not carry a lifecycle timestamp of their own.
    const payload = { ...message, params: { ...(message.params || {}), pandaReceivedAt: new Date().toISOString() } };
    broadcast({ type: "codex/notification", payload });
  }
}

function broadcast(data: any) {
  const text = JSON.stringify(data);
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  for (const client of sseClients) if (!client.writableEnded) client.write(`data: ${text}\n\n`);
}

const browserDispatch = createBrowserDispatch({
  isAllowedMethod: isAllowedBrowserRpcMethod,
  request,
  pendingServerRequests: pendingCodexRequests,
  sendRaw,
  broadcast,
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
  appServerConnection.mode === "shared" && params.itemsView === "full" ? threadHub.readBrowserTurns(params) : undefined,
);
browserDispatch.resolve("host/thread/live", ({ params }) => threadHub.readLiveThread(params.threadId));
browserDispatch.resolve("thread/resume", ({ params, flags }) =>
  appServerConnection.mode === "shared" && (flags.pandaPrepareInput === true || params.excludeTurns === true)
    ? prepareSharedInput({ request, getThreadMetadata: threadHub.getThreadMetadata }, params)
    : undefined,
);
browserDispatch.after(({ method, params }) => {
  if (method === "thread/delete") threadHub.invalidateHistory(params.threadId);
});
browserDispatch.after(({ result }) => threadHub.recordThreadPathsFromRpc(result));
browserDispatch.after(({ method, params, result }) => {
  try {
    const snapshot =
      method === "thread/delete"
        ? projectCatalog.forgetSession(params.threadId)
        : method === "thread/name/set"
          ? projectCatalog.refreshSessions([{ id: params.threadId, name: params.name }])
          : Array.isArray(result?.data) && method === "thread/list"
            ? projectCatalog.refreshSessions(result.data)
            : null;
    if (snapshot) broadcast({ type: "project-catalog/changed", ...snapshot });
  } catch (error) {
    console.warn(
      "[panda-force] project session metadata update failed",
      error instanceof Error ? error.message : "unknown",
    );
  }
});
browserDispatch.after(({ method, params, result }) => threadHub.recordReviewDiffsFromRpc(method, params, result));
// Metadata-only rejoin subscribes an already-loaded thread to live approvals,
// including when its history is served through bounded native item pages.
browserDispatch.after(async ({ method, result }) => {
  if (["host/thread/history", "thread/read"].includes(method)) await threadHub.subscribeSharedThread(result?.thread);
});
browserDispatch.after(({ method, params, result }) => {
  if (["host/thread/history", "thread/read"].includes(method)) goalStore.emit(result?.thread?.id || params.threadId);
});
browserDispatch.after(({ method, result }) => {
  if (
    appServerConnection.mode === "shared" &&
    ["thread/start", "thread/resume"].includes(method) &&
    result?.thread?.id &&
    !result.pandaAlreadyLoaded
  )
    threadHub.markSubscribed(result.thread.id);
});
browserDispatch.after(({ method, params, flags, result, replyExtras }) => {
  if (method !== "thread/start") return;
  if (result?.thread?.id && !flags.pandaProjectless) {
    try {
      if (projectVisibility.setHidden(result.thread.cwd || params.cwd || defaultCwd, false)) {
        broadcast({ type: "projects/visibility", ...projectVisibility.snapshot() });
      }
    } catch (error) {
      // A completed creation must not look like a failed RPC and be retried.
      console.error("[panda-force] could not restore project visibility:", error);
    }
  }
  replyExtras.projectVisibility = projectVisibility.snapshot();
});
browserDispatch.after(({ method, params }) => {
  if (["thread/resume", "thread/queue/add", "thread/queue/list"].includes(method))
    void recoverMessageQueue(params.threadId);
});

async function dispatchBrowserMessage(message: any) {
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

async function handleClient(client: WebSocket, message: any) {
  try {
    client.send(JSON.stringify(await dispatchBrowserMessage(message)));
  } catch (error) {
    client.send(JSON.stringify(rpcErrorPayload(message?.id, error)));
  }
}

function sendAuthError(res: ServerResponse, status: number, error: string, extraHeaders: Record<string, string> = {}) {
  respondJson(res, status, { error }, extraHeaders);
}

function encodeContentDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const dispatchApiRoute = createRouter([
  {
    path: "/api/approvals",
    method: "GET",
    handler: ({ res }) => respondJson(res, 200, { requests: [...pendingCodexRequests.values()] }),
  },
  ...projectRoutes({
    catalog: projectCatalog,
    request,
    getSession: (id: string) => threadHub.getThreadMetadata(id),
    recordSessions: (result: any) => threadHub.recordThreadPathsFromRpc(result),
    broadcast,
  }),
  {
    path: "/api/events",
    method: "GET",
    handler: ({ req, res, idaasSession }) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      res.flushHeaders?.();
      if (idaasAuth && idaasSession) {
        const unwatch = idaasAuth.watch(idaasSession.id, () => {
          if (!res.writableEnded) res.end(`data: ${JSON.stringify({ type: "auth/required" })}\n\n`);
        });
        res.once("close", unwatch);
      }
      res.write("retry: 1000\n\n");
      sseClients.add(res);
      res.write(`data: ${JSON.stringify({ type: "projects/visibility", ...projectVisibility.snapshot() })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ type: "bridge/status", status: codexBridge.connected ? "connected" : "connecting" })}\n\n`,
      );
      for (const payload of pendingCodexRequests.values())
        res.write(`data: ${JSON.stringify({ type: "codex/request", payload })}\n\n`);
      req.on("close", () => sseClients.delete(res));
    },
  },
  {
    path: ["/api/rpc", "/api/codex/respond"],
    method: "POST",
    handler: async ({ req, res, url }) => {
      try {
        const payload = await readJsonBody(req);
        const message =
          url.pathname === "/api/rpc"
            ? { type: "rpc", id: payload.id, method: payload.method, params: payload.params || {} }
            : {
                type: payload.error ? "codex/error" : "codex/response",
                id: payload.id,
                requestId: payload.requestId,
                result: payload.result,
                error: payload.error,
              };
        const reply = await dispatchBrowserMessage(message);
        const body = Buffer.from(JSON.stringify(reply));
        const acceptsGzip = String(req.headers["accept-encoding"] || "")
          .split(",")
          .some((value) => {
            const [encoding, ...params] = value.trim().split(";");
            const quality = params.find((param) => param.trim().startsWith("q="));
            return encoding === "gzip" && (!quality || Number(quality.trim().slice(2)) > 0);
          });
        const compressed = body.length > 1024 && acceptsGzip;
        const payloadBody = compressed ? gzipSync(body) : body;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          vary: "Accept-Encoding",
          "content-length": payloadBody.length,
          ...(compressed ? { "content-encoding": "gzip" } : {}),
        });
        res.end(payloadBody);
      } catch (error) {
        respondError(res, 400, error);
      }
    },
  },
  {
    path: "/api/projects/visibility",
    method: ["GET", "POST"],
    handler: async ({ req, res }) => {
      try {
        if (req.method === "POST") {
          const { project, hidden, expectedHiddenAt } = await readJsonBody(req);
          if (projectVisibility.setHidden(project, hidden, expectedHiddenAt))
            broadcast({ type: "projects/visibility", ...projectVisibility.snapshot() });
        }
        respondJson(res, 200, projectVisibility.snapshot());
      } catch (error) {
        respondError(res, 400, error);
      }
    },
  },
  {
    path: "/api/health",
    handler: ({ res }) =>
      respondJson(res, 200, {
        ok: true,
        codex: codexBridge.connected,
        version: config.version,
        appServerMode: appServerConnection.mode,
      }),
  },
  {
    path: "/api/config",
    handler: ({ res }) =>
      respondJson(res, 200, {
        home: homeDir,
        defaultCwd,
        reviewRoot: reviewRoots[0],
        browseRoots,
        projectless,
        attachmentStorage: attachmentStorage ? "oss" : "local",
        attachmentUrlPrefix: attachmentStorage?.urlPrefix || null,
      }),
  },
  {
    path: "/api/composer/history",
    method: "GET",
    handler: async ({ res }) => {
      try {
        const entries = await readComposerHistory(resolve(threadHub.sessionsRoot, ".."));
        respondJson(res, 200, { entries });
      } catch {
        respondJson(res, 500, { error: "Could not read composer history" });
      }
    },
  },
  {
    path: "/api/attachments",
    method: "POST",
    handler: async ({ req, res, url }) => {
      try {
        const attachment = await saveAttachment(req, attachmentRoot, url.searchParams.get("name"), attachmentStorage);
        respondJson(res, 201, { attachment });
      } catch (error: any) {
        respondJson(res, error.status || 400, { error: error.code ? "Could not save attachment" : error.message });
      }
    },
  },
  {
    path: "/api/attachments/read",
    method: ["GET", "HEAD"],
    handler: async ({ res, url }) => {
      try {
        if (!attachmentStorage) throw new Error("OSS attachment storage is disabled");
        const location = await attachmentStorage.readUrl(url.searchParams.get("url"));
        res.writeHead(302, { location, "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
        res.end();
      } catch {
        respondJson(res, 404, { error: "Attachment unavailable" });
      }
    },
  },
  {
    path: "/api/workspace/context",
    handler: ({ res, url }) => {
      try {
        const context = readWorkspaceContext(url.searchParams.get("cwd") || defaultCwd, browseRoots);
        respondJson(res, 200, context);
      } catch (error) {
        respondError(res, 400, error);
      }
    },
  },
  {
    path: "/api/files/search",
    handler: async ({ res, url }) => {
      try {
        const cwd = url.searchParams.get("cwd") || defaultCwd;
        const query = url.searchParams.get("query") || "";
        const items = await searchWorkspaceFiles(cwd, query, { allowedRoots: browseRoots, limit: 30 });
        respondJson(res, 200, { cwd, query, items });
      } catch (error) {
        respondError(res, 400, error);
      }
    },
  },
  {
    path: "/api/workspace/tree",
    method: "GET",
    handler: ({ res, url }) => {
      try {
        const cwd = url.searchParams.get("cwd") || defaultCwd;
        const path = url.searchParams.get("path") || "";
        const result = listWorkspaceEntries(cwd, path, { allowedRoots: fileRoots });
        respondJson(res, 200, result);
      } catch (error) {
        respondError(res, 400, error);
      }
    },
  },
  {
    path: ["/api/git/status", "/api/git/diff", "/api/git/history"],
    method: "GET",
    handler: ({ res, url }) => {
      try {
        const cwd = url.searchParams.get("cwd") || defaultCwd;
        let result;
        if (url.pathname === "/api/git/status") result = readGitStatus(cwd, fileRoots);
        else if (url.pathname === "/api/git/diff")
          result = readGitDiff(cwd, url.searchParams.get("path"), {
            allowedRoots: fileRoots,
            scope: url.searchParams.get("scope") || "head",
            commit: url.searchParams.get("commit") || "",
          });
        else
          result = readGitHistory(cwd, url.searchParams.get("path"), {
            allowedRoots: fileRoots,
            limit: Number(url.searchParams.get("limit") || 50),
          });
        respondJson(res, 200, result);
      } catch (error) {
        respondError(res, 400, error);
      }
    },
  },
  {
    path: "/api/files/download",
    method: "GET",
    handler: ({ req, res, url }) => {
      try {
        const file = resolveLocalFile(url.searchParams.get("path"), {
          cwd: url.searchParams.get("cwd") || defaultCwd,
          home: homeDir,
          allowedRoots: fileRoots,
        });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(file.size),
          "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeContentDispositionFilename(file.filename)}`,
          "cache-control": "no-store",
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        });
        const stream = createReadStream(file.path);
        stream.on("error", () => res.destroy());
        req.on("aborted", () => stream.destroy());
        stream.pipe(res);
      } catch {
        respondJson(res, 404, { error: "File unavailable" });
      }
    },
  },
  {
    path: "/api/images/local",
    method: "GET",
    handler: async ({ res, url }) => {
      try {
        const image = resolveLocalImage(url.searchParams.get("path"), {
          cwd: url.searchParams.get("cwd") || defaultCwd,
          home: homeDir,
          allowedRoots: imageRoots,
        });
        const thumbnail = url.searchParams.get("thumbnail") === "1";
        const bytes = thumbnail ? await imageThumbnail(image) : readFileSync(image.path);
        res.writeHead(200, {
          "content-type": thumbnail ? "image/webp" : image.contentType,
          "content-length": String(bytes.length),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(thumbnail ? `${image.filename}.webp` : image.filename)}`,
          "cache-control": thumbnail ? "private, no-cache" : "private, max-age=60",
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        });
        res.end(bytes);
      } catch (error: any) {
        respondJson(res, error.status === 503 ? 503 : 404, { error: "Image unavailable" });
      }
    },
  },
  {
    path: ["/api/account", "/api/account/avatar"],
    handler: async ({ res, url }) => {
      try {
        const account = await accountLoader.get(url.searchParams.get("refresh") === "1");
        if (url.pathname === "/api/account") {
          respondJson(res, 200, toPublicAccountIdentity(account));
          return;
        }
        if (!account.imageUrl) {
          respondJson(res, 404, { error: "No profile avatar" });
          return;
        }
        const avatar = await fetchProfileAvatar(account.imageUrl);
        res.writeHead(200, {
          "content-type": avatar.contentType,
          "content-length": String(avatar.body.byteLength),
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
        });
        res.end(avatar.body);
      } catch (error) {
        console.warn("[panda-force] account request failed:", error instanceof Error ? error.message : String(error));
        if (url.pathname === "/api/account/avatar") {
          respondJson(res, 502, { error: "Profile avatar unavailable" });
          return;
        }
        respondJson(
          res,
          200,
          toPublicAccountIdentity(await resolveAccountIdentity({ account: null, requiresOpenaiAuth: true })),
        );
      }
    },
  },
  {
    path: "/api/folders",
    handler: ({ res, url }) => {
      try {
        const path = resolveBrowsePath(url.searchParams.get("path") || "~", browseRoots, homeDir);
        if (!isDirectory(path)) throw new Error("Directory not found");
        respondJson(res, 200, listFolders(path, browseRoots));
      } catch (error) {
        respondError(res, 400, error);
      }
    },
  },
  {
    path: "/api/review/patch",
    method: "POST",
    handler: ({ req, res }) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy(new Error("Review patch payload too large"));
      });
      req.on("end", async () => {
        let requestPayload: ReturnType<typeof parseReviewPatchRequest> | null = null;
        let operationStarted = false;
        let success = false;
        try {
          const payload = JSON.parse(body || "{}");
          requestPayload = parseReviewPatchRequest(payload);
          const stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
          operationStarted = true;
          const threadResult =
            appServerConnection.mode === "shared"
              ? { thread: await threadHub.getThreadMetadata(requestPayload.threadId) }
              : await request("thread/read", { threadId: requestPayload.threadId, includeTurns: false });
          const cwd = threadResult?.thread?.cwd;
          if (typeof cwd !== "string" || !cwd) throw new Error("Thread working directory is unavailable");
          const result = await applyReviewPatch({ cwd, diff: stored.diff, action: requestPayload.action }, reviewRoots);
          success = true;
          respondJson(res, 200, result);
        } catch (error) {
          respondError(res, 400, error);
        } finally {
          if (operationStarted && requestPayload)
            reviewDiffs.finish(requestPayload.threadId, requestPayload.turnId, requestPayload.action, success);
        }
      });
    },
  },
  {
    path: (pathname) => pathname.startsWith("/vendor/katex/"),
    handler: ({ res, url }) => {
      let relativePath;
      try {
        relativePath = decodeURIComponent(url.pathname.slice("/vendor/katex/".length));
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const katexDir = resolve(appRoot, "node_modules/katex/dist");
      const file = resolveSafeRegularFile(katexDir, relativePath);
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": mime[extname(file)] || "application/octet-stream",
        "cache-control": "public, max-age=86400",
      });
      res.end(readFileSync(file));
    },
  },
  {
    path: "/vendor/xterm/xterm.css",
    handler: ({ res }) => {
      const xtermDir = resolve(appRoot, "node_modules/@xterm/xterm/css");
      const file = resolveSafeRegularFile(xtermDir, "xterm.css");
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" });
      res.end(readFileSync(file));
    },
  },
]);

const server = createServer(async (req, res) => {
  let url: URL;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    respondJson(res, 400, { error: "Invalid request URL" });

    return;
  }
  if (["/health/startup", "/health/liveness", "/health/readiness"].includes(url.pathname)) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendAuthError(res, 405, "Method not allowed", { allow: "GET, HEAD" });
      return;
    }
    const healthy = !shuttingDown && (url.pathname !== "/health/readiness" || codexBridge.connected);
    respondJson(res, healthy ? 200 : 503, { ok: healthy });
    return;
  }
  const appRoute =
    req.method === "GET" &&
    (url.pathname === "/" ||
      /^\/(?:settings(?:\/[^/]+)?|workspace|tasks|projects|project|deliverables|connections|new|task\/[^/]+)\/?$/.test(
        url.pathname,
      ));
  const loginAssets = new Set([
    "/",
    "/index.html",
    "/style.css",
    "/workbench.css",
    "/favicon.svg",
    "/auth-bootstrap.js",
    "/i18n.js",
    "/panda-brand.js",
  ]);
  let idaasSession: { id: string; identity: any; expiresAt: number } | null = null;
  if (idaasAuth) {
    if (await idaasAuth.handle(req, res, url)) return;
    try {
      idaasSession = await idaasAuth.authenticate(req);
    } catch (error: any) {
      if (
        (error.status === 401 ||
          (error.status === 403 && req.headers["sec-fetch-mode"] === "navigate" && !req.headers.origin)) &&
        (appRoute || url.pathname === "/index.html")
      ) {
        res.writeHead(302, { location: sessionLoginUrl(url.pathname + url.search), "cache-control": "no-store" });
        res.end();
        return;
      }
      if (error.status === 401 && req.method === "GET" && loginAssets.has(url.pathname)) {
        const file = resolvePublicAsset(url.pathname, publicDir);
        if (file) {
          serveStaticAsset(req, res, file, mime[extname(file)] || "application/octet-stream");
          return;
        }
      }
      sendAuthError(
        res,
        error instanceof AuthError ? error.status : 503,
        error instanceof AuthError ? error.message : "Authentication unavailable",
      );
      return;
    }
  }
  if (!idaasAuth && (await passwordAuth.handle(req, res, url))) return;
  if (!idaasAuth && !passwordAuth.isAuthorized(req)) {
    if (appRoute || loginAssets.has(url.pathname)) {
      const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
      if (file) {
        serveStaticAsset(req, res, file, mime[extname(file)] || "application/octet-stream");
        return;
      }
    }
    unauthorizedResponse(res);
    return;
  }
  if (await dispatchApiRoute({ req, res, url, idaasSession })) return;
  const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  serveStaticAsset(req, res, file, mime[extname(file)] || "application/octet-stream");
});

// Bun's default keep-alive timer can close a response while it is still
// draining to a slow client. Disable it for large RPC bodies and SSE streams;
// native RPC deadlines and the reverse proxy still bound request lifetimes.
server.keepAliveTimeout = 0;

const sseKeepalive = setInterval(() => {
  for (const client of sseClients) if (!client.writableEnded) client.write(": keepalive\n\n");
}, 25_000);
sseKeepalive.unref();

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
});
const terminalWss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }
  let idaasSession: { id: string } | null = null;
  let status = 401;
  try {
    if (idaasAuth) idaasSession = await idaasAuth.authenticate(req);
  } catch (error: any) {
    status = error instanceof AuthError ? error.status : 503;
  }
  if (
    (pathname !== "/ws" && pathname !== "/terminal") ||
    (idaasAuth ? !idaasSession : !passwordAuth.isAuthorized(req))
  ) {
    const body = JSON.stringify({ error: "Authentication required" });
    // Reconnect failures must not trigger browser-native Basic authentication prompts.
    socket.end(
      [
        `HTTP/1.1 ${status} ${status === 503 ? "Service Unavailable" : status === 403 ? "Forbidden" : "Unauthorized"}`,
        "Connection: close",
        "Content-Type: application/json; charset=utf-8",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "X-Content-Type-Options: nosniff",
        "",
        body,
      ].join("\r\n"),
    );
    return;
  }
  if (socket.destroyed) return;
  const target = pathname === "/terminal" ? terminalWss : wss;
  target.handleUpgrade(req, socket, head, (client) => {
    if (idaasAuth && idaasSession) {
      const unwatch = idaasAuth.watch(idaasSession.id, () => client.terminate());
      client.once("close", unwatch);
    }
    target.emit("connection", client, req);
  });
});
wss.on("connection", (client) => {
  clients.add(client);
  client.send(JSON.stringify({ type: "projects/visibility", ...projectVisibility.snapshot() }));
  client.send(JSON.stringify({ type: "bridge/status", status: codexBridge.connected ? "connected" : "connecting" }));
  for (const payload of pendingCodexRequests.values()) client.send(JSON.stringify({ type: "codex/request", payload }));
  client.on("message", (raw) => {
    try {
      handleClient(client, JSON.parse(String(raw)));
    } catch (error) {
      client.send(JSON.stringify({ type: "rpc/error", error: String(error) }));
    }
  });
  client.on("close", () => clients.delete(client));
});
terminalWss.on("connection", (client, req) => {
  let terminal: ReturnType<typeof createTerminalSession> | null = null;
  try {
    const url = new URL(req.url || "/terminal", "http://localhost");
    const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), browseRoots, defaultCwd);
    terminal = createTerminalSession({
      cwd,
      cols: 100,
      rows: 24,
      onData: (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      },
      onExit: (event) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`\r\n[Process exited ${event.exitCode}]\r\n`);
          client.close(1000, "Terminal exited");
        }
      },
    });
    terminalSessions.set(client, terminal);
  } catch (error) {
    console.error("[panda-force] terminal failed", error);
    client.close(1011, "Terminal unavailable");
    return;
  }
  client.on("message", (raw, isBinary) => {
    if (!terminal || raw.byteLength > 1_000_000) return;
    if (isBinary) {
      terminal.write(Buffer.from(raw as Buffer).toString("utf8"));
      return;
    }
    try {
      const resize = normalizeTerminalResize(JSON.parse(String(raw)));
      if (resize) terminal.resize(resize.cols, resize.rows);
    } catch {
      /* Terminal input is sent as binary; ignore malformed control frames. */
    }
  });
  client.on("close", () => {
    terminalSessions.delete(client);
    terminal?.kill();
    terminal = null;
  });
  client.on("error", () => client.close());
});

if (process.env.NODE_ENV === "production") {
  if (!existsSync(resolve(publicDir, "app.bundle.js")))
    throw new Error("Production frontend bundle is missing; build the image first");
} else {
  // The build definition lives only in package.json; development startup reuses it.
  const frontendBuild = Bun.spawnSync(["bun", "run", "build:client"], {
    cwd: appRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (frontendBuild.exitCode !== 0) throw new Error("Frontend build failed; see build:client output");
}

codexBridge.start();
goalStore.start();
server.listen(port, host, () => {
  console.log(`PandaForce listening on http://${host}:${port}`);
  if (!idaasAuth && passwordAuth.passwordSetupRequired()) {
    console.warn(
      `[panda-force] Create your administrator account in the browser. No password startup options are required.`,
    );
    console.warn(`[panda-force] Remote installation code: ${passwordAuth.installationCode()}`);
  }
  if (!localhostOnly) {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === "IPv4" && !entry.internal);
    for (const entry of addresses) console.log(`LAN: http://${entry.address}:${port} (authentication required)`);
  }
});

function shutdown() {
  if (shuttingDown) return;
  goalStore.stop();
  shuttingDown = true;
  idaasAuth?.close();
  codexBridge.cancelRestart();
  clearInterval(sseKeepalive);
  codexBridge.rejectPending(new Error("PandaForce is shutting down"));
  for (const client of clients) client.terminate();
  clients.clear();
  for (const client of sseClients) client.end();
  sseClients.clear();
  wss.close();
  for (const [client, terminal] of terminalSessions) {
    terminal.kill();
    client.terminate();
  }
  terminalSessions.clear();
  terminalWss.close();
  codexBridge.terminate();
  server.close(() => {
    httpClosed = true;
    maybeFinishShutdown();
  });
  server.closeAllConnections?.();
  const forceExit = setTimeout(() => {
    codexBridge.terminate("SIGKILL");
    process.exit(0);
  }, 5000);
  forceExit.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
