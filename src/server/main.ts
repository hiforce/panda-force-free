import { INSTALL_ASSETS } from "../shared/install-assets.js";
import { createBrowserWire } from "./bridge/browser-wire.js";
import { readClusterConfig } from "./cluster/config.js";
import { createClusterWorker } from "./cluster/worker.js";
import { SUPPORTED_LOCALES } from "../shared/i18n/locale-policy.js";
import { isRecord } from "../shared/records.js";
import { errorMessage, errorStatus } from "./../shared/errors.js";
import { installBrowserConnections } from "./bridge/browser-connections.js";
import { createBrowserEngine } from "./bridge/browser-engine.js";
import { createEngineNotifications } from "./bridge/engine-notifications.js";
import { accountRoutes } from "./http/account-routes.js";
import { assetsRoutes } from "./http/assets-routes.js";
import { bridgeRoutes } from "./http/bridge-routes.js";
import { withRequestErrors } from "./http/request-handler.js";
import { workspaceRoutes } from "./http/workspace-routes.js";
import type { EngineEnvelope } from "../shared/engine/contracts.js";
import { createInstalledEngine } from "./engines/installed.js";
/**
 * HTTP/WS composition root. Authenticate before routing workspace operations.
 * Shared mode attaches to the host daemon without owning its process lifetime;
 * shutdown closes this service's clients and workers, never the shared daemon.
 * Persistent application metadata, model state and workspace files have distinct
 * storage owners; do not clear one as a shortcut for resetting another.
 */
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, resolve } from "node:path";
import { WebSocket } from "ws";
import { sessionLoginUrl } from "../shared/auth-return-path.js";
import { rpcErrorPayload } from "../shared/bridge-errors.js";
import { AuthError, createIdaasAuth, readIdaasConfig } from "./auth/idaas.js";
import { createPasswordAuth } from "./auth/routes.js";
import { resolvePublicAsset, unauthorizedResponse } from "./auth/security.js";
import { createAuthState } from "./auth/state.js";
import { resolveAppServerConnection } from "./bridge/app-server-connection.js";
import { assertStartupAuth, config } from "./config.js";
import { respondJson } from "./http/respond.js";
import { createRouter } from "./http/router.js";
import { serveStaticAsset } from "./http/static-assets.js";
import { createAccountIdentityLoader, resolveAccountIdentity } from "./misc/profile.js";
import { ProjectVisibilityStore } from "./misc/project-visibility.js";
import { ProjectCatalog } from "./projects/catalog.js";
import { ProjectWorkspaceService } from "./projects/workspaces/service.js";
import { ProjectDirectoryPolicy } from "./projects/directory-policy.js";
import { ReviewDiffStore } from "./review/state.js";
import { createLocalImagePresenter } from "./workspace/image-presentation.js";
import { createImageThumbnailCache } from "./workspace/image-thumbnails.js";
import { createOssAttachmentStorage, readOssAttachmentConfig } from "./workspace/oss-attachments.js";

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
function presentBrowserData<T>(value: T): T {
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
const clusterConfig = readClusterConfig();
if (clusterConfig?.role === "gateway") throw new Error("Start gateways with bun run start");
if (clusterConfig && appServerConnection.mode !== "isolated")
  throw new Error("Cluster workers require an isolated engine so ownership loss can stop the writer");
const cluster = clusterConfig
  ? await createClusterWorker(clusterConfig, () => process.kill(process.pid, "SIGTERM"))
  : null;

console.info(
  "[PandaForce] Native engine connection",
  JSON.stringify({ mode: appServerConnection.mode, cwd: defaultCwd }),
);
const projectVisibility = new ProjectVisibilityStore(config.projectVisibilityPath, homeDir);
const projectCatalog = new ProjectCatalog(config.projectCatalogPath);
const projectWorkspaces = new ProjectWorkspaceService(
  projectCatalog,
  config.projectWorkspaceRoot,
  appServerConnection.mode !== "shared" || config.projectWorkspaceRootConfigured,
);
if (!config.allowExternalDirectories) await projectWorkspaces.initialize();
const directoryPolicy = new ProjectDirectoryPolicy(config.projectWorkspaceRoot, config.allowExternalDirectories);
const browserWire = createBrowserWire();
const clients = new Set<WebSocket>();
const sseClients = new Set<ServerResponse>();
const pendingEngineRequests = new Map<number | string, EngineEnvelope>();
let shuttingDown = false;
let httpClosed = false;
let finishingShutdown = false;
const reviewDiffs = new ReviewDiffStore();
const installedEngine = createInstalledEngine({
  id: config.engineId,
  connection: appServerConnection,
  defaultCwd,
  home: homeDir,
  version: config.version,
  sessionsRoot: config.defaultCodexSessionsRoot,
  reviewDiffs,
  isShuttingDown: () => shuttingDown,
  authorize: () => cluster?.assertOwner(),
  broadcast,
});
const {
  driver: engineDriver,
  history: threadHub,
  goals: goalStore,
  recovery: autoContinueRecovery,
  recoverQueue: recoverMessageQueue,
} = installedEngine;
const accountLoader = createAccountIdentityLoader(async (refresh) => {
  const account = await request("account/read", { refreshToken: refresh });
  return resolveAccountIdentity(account);
});
const handleEngineMessage = createEngineNotifications({
  presentBrowserData,
  projectCatalog,
  pendingEngineRequests,
  autoContinueRecovery,
  reviewDiffs,
  recoverMessageQueue,
  threadHub,
  accountLoader,
  request,
  broadcast,
});
engineDriver.subscribe((event) => {
  if (event.kind === "notification" || event.kind === "approval") {
    if (directoryPolicy.envelope(event.envelope)) handleEngineMessage(event.envelope);
  } else if (event.kind === "connected") {
    const info = event.info;
    broadcast({ type: "bridge/status", status: "connected", info, engine: engineDriver.descriptor });
  } else {
    accountLoader.invalidate();
    reviewDiffs.clear();
    threadHub.clearHistory();
    pendingEngineRequests.clear();
    threadHub.clearSubscriptions();
    broadcast({ type: "bridge/status", status: "disconnected", code: event.code, signal: event.signal });
    if (shuttingDown) maybeFinishShutdown();
  }
});

async function request(method: string, params: Record<string, unknown> = {}) {
  const result = await installedEngine.request(method, params);
  return presentBrowserData(result);
}

function sendRaw(message: object) {
  if (!isRecord(message) || (typeof message.id !== "string" && typeof message.id !== "number"))
    throw new Error("Invalid engine response identity");
  engineDriver.respond(message.id, message.result, message.error);
}

function maybeFinishShutdown() {
  if (shuttingDown && httpClosed && engineDriver.fullyStopped() && !finishingShutdown) {
    finishingShutdown = true;
    if (cluster)
      void cluster
        .close(true)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    else process.exit(0);
  }
}

function broadcast(data: object) {
  const visible = directoryPolicy.event(data);
  if (!visible) return;
  if (cluster) cluster.publish(visible, deliver);
  else deliver(visible);
}
function deliver(data: object, event?: import("./cluster/contracts.js").JournalEvent) {
  for (const client of clients)
    if (client.readyState === WebSocket.OPEN) client.send(browserWire.stringify(client, data));
  for (const client of sseClients)
    if (!client.writableEnded)
      client.write(
        `${event ? "id: " + event.fence + ":" + event.sequence + "\n" : ""}data: ${browserWire.stringify(client, data)}\n\n`,
      );
}

const localBrowserMessage = createBrowserEngine({
  sendRaw,
  attachmentStorage,
  defaultCwd,
  browseRoots,
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
  request,
  broadcast,
});

function validateBrowserResponse(message: unknown) {
  if (
    !isRecord(message) ||
    !["engine/response", "engine/error", "codex/response", "codex/error"].includes(String(message.type))
  )
    return;
  if (
    (typeof message.requestId === "string" || typeof message.requestId === "number") &&
    pendingEngineRequests.has(message.requestId)
  )
    engineDriver.validateResponse(message.requestId, message.result, message.error);
}
const dispatchBrowserMessage = (message: unknown) =>
  cluster ? cluster.dispatch(message, localBrowserMessage, validateBrowserResponse) : localBrowserMessage(message);

async function handleClient(client: WebSocket, message: unknown) {
  try {
    client.send(JSON.stringify(await dispatchBrowserMessage(message)));
  } catch (error) {
    client.send(JSON.stringify(rpcErrorPayload(isRecord(message) ? message.id : undefined, error)));
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
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const dispatchApiRoute = createRouter([
  ...bridgeRoutes({
    browserWire,
    projectless,
    defaultCwd,
    browseRoots,
    request,
    idaasAuth,
    attachmentStorage,
    homeDir,
    reviewRoots,
    appServerConnection,
    projectVisibility,
    projectCatalog,
    projectWorkspaces,
    directoryPolicy,
    sseClients,
    pendingEngineRequests,
    threadHub,
    engineDriver,
    broadcast,
    dispatchBrowserMessage,
    cluster,
    watchPasswordSession: (request, close) => passwordAuth.watch(request, close),
  }),
  ...workspaceRoutes({
    projectWorkspaces,
    attachmentStorage,
    imageThumbnail,
    homeDir,
    defaultCwd,
    browseRoots,
    attachmentRoot,
    imageRoots,
    fileRoots,
    threadHub,
    directoryPolicy,
    encodeContentDispositionFilename,
  }),
  ...accountRoutes({ reviewRoots, appServerConnection, reviewDiffs, threadHub, accountLoader, request }),
  ...assetsRoutes({ appRoot, mime }),
]);

const server = createServer(
  withRequestErrors(async (req, res) => {
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
      let ownsWorkspace = true;
      try {
        cluster?.assertOwner();
      } catch {
        ownsWorkspace = false;
      }
      const healthy =
        !shuttingDown && ownsWorkspace && (url.pathname !== "/health/readiness" || engineDriver.connected);
      respondJson(res, healthy ? 200 : 503, { ok: healthy });
      return;
    }
    if (cluster) {
      try {
        await cluster.verify(req);
      } catch (error) {
        respondJson(res, errorStatus(error), { error: errorMessage(error), code: "cluster_request_rejected" });
        return;
      }
    }
    const appRoute =
      req.method === "GET" &&
      (url.pathname === "/" ||
        /^\/(?:settings(?:\/[^/]+)?|workspace|tasks|projects|project|deliverables|connections|new|task\/[^/]+)\/?$/.test(
          url.pathname,
        ));
    const loginAssets = new Set([
      ...SUPPORTED_LOCALES.map((locale) => `/locales/${locale.code}.json`),
      "/",
      "/index.html",
      "/style.css",
      "/workbench.css",
      "/session-workspace.css",
      "/workbench-chrome.css",
      "/workbench-layout.css",
      "/appearance.css",
      "/favicon.svg",
      "/auth-bootstrap.js",
      "/i18n.js",
      "/http-client.js",
      "/panda-brand.js",
      "/assets/panda-mark.svg",
      ...INSTALL_ASSETS,
    ]);
    let idaasSession: { id: string; identity: unknown; expiresAt: number } | null = null;
    if (url.pathname === "/api/auth/status" && directoryPolicy.browserScope)
      res.setHeader("x-panda-directory-scope", directoryPolicy.browserScope);
    if (idaasAuth) {
      if (await idaasAuth.handle(req, res, url)) return;
      try {
        idaasSession = await idaasAuth.authenticate(req);
      } catch (error) {
        if (
          (errorStatus(error) === 401 ||
            (errorStatus(error) === 403 && req.headers["sec-fetch-mode"] === "navigate" && !req.headers.origin)) &&
          (appRoute || url.pathname === "/index.html")
        ) {
          res.writeHead(302, { location: sessionLoginUrl(url.pathname + url.search), "cache-control": "no-store" });
          res.end();
          return;
        }
        if (errorStatus(error) === 401 && req.method === "GET" && loginAssets.has(url.pathname)) {
          const file = resolvePublicAsset(url.pathname, publicDir);
          if (file) {
            serveStaticAsset(req, res, file, mime[extname(file)] || "application/octet-stream");
            return;
          }
        }
        sendAuthError(
          res,
          error instanceof AuthError ? errorStatus(error) : 503,
          error instanceof AuthError ? errorMessage(error) : "Authentication unavailable",
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
  }),
);

// Bun's default keep-alive timer can close a response while it is still
// draining to a slow client. Disable it for large RPC bodies and SSE streams;
// native RPC deadlines and the reverse proxy still bound request lifetimes.
server.keepAliveTimeout = 0;

const browserConnections = installBrowserConnections({
  browserWire,
  server,
  idaasAuth,
  passwordAuth,
  clients,
  sseClients,
  pendingEngineRequests,
  projectVisibility,
  engineDriver,
  browseRoots,
  defaultCwd,
  handleClient,
  cluster,
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

engineDriver.start();
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
  engineDriver.cancelRestart();
  engineDriver.rejectPending(new Error("PandaForce is shutting down"));
  browserConnections.close();
  passwordAuth.close();
  engineDriver.stop();
  server.close(() => {
    httpClosed = true;
    maybeFinishShutdown();
  });
  server.closeAllConnections?.();
  const forceExit = setTimeout(() => {
    engineDriver.stop("SIGKILL");
    process.exit(0);
  }, 5000);
  forceExit.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
