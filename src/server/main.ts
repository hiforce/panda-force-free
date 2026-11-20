import { createOriginalStorageFeature } from "./object-storage/feature.js";
import { EngineImages } from "./workspace/engine-images.js";
import { engineImageRoutes } from "./http/engine-image-routes.js";
import { isApplicationSession } from "./engines/application-tools/sessions.js";
import { upgradeSystemGadgetLayout } from "../gadget/system/layout.js";
import { createApplicationContent } from "./application/content.js";
import { createApplicationAuthentication } from "./application/authentication.js";
import { createApplicationProjects } from "./application/projects.js";
import { createApplicationExtensions } from "./application/extensions.js";
import { createApplicationDocuments } from "./application/documents.js";
import { createApplicationPublication } from "./application/publication.js";
import {
  startApplicationBackground,
  startApplicationIngress,
  drainApplicationBackground,
  closeApplicationStorage,
} from "./application/lifecycle.js";
import { registerSystemGadgets } from "../gadget/system/server.js";
import { createGadgetFeature } from "./gadget/feature.js";
import { systemGadgetPorts } from "../gadget/system/integration.js";
import { databaseConfigurationSummary } from "./database/config.js";
import { drainCatalogUpdates } from "./projects/publish.js";
import { createConfiguredBotFeature } from "./bots/configured-feature.js";
import { createBotFeature } from "./bots/feature.js";
import { bootstrapApplicationDatabase } from "./database/bootstrap.js";
import { createDatabaseReadiness } from "./database/health.js";
import { createDatabaseManagementFeature, databaseAdministratorAllowlist } from "./database/management/feature.js";
import { createMySQLRuntimeStores } from "./database/runtime-stores.js";
import { createCliFeature } from "./cli/integration/feature.js";
import { cliContentCommands } from "./cli/integration/content.js";
import { createInterfaceAssets } from "./http/interface-assets.js";
import { creativeAssetRoutes } from "./creative/assets/routes.js";
import { contentSourceRoutes } from "./content-sources/routes.js";
import { closeCreativeText } from "./creative/assets/projection.js";
import { personalCopyRoute } from "./creative/copy.js";
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
import { CREATION_STYLES } from "../shared/template-previews/assets.js";
import {
  KNOWLEDGE_STYLES,
  CLI_STYLES,
  BOT_STYLES,
  DATABASE_STYLES,
  ORIGINAL_STORAGE_STYLES,
  GADGET_STYLES,
  GADGET_RUNTIME_ASSETS,
} from "../shared/interface-assets.js";

/**
 * HTTP/WS composition root. Authenticate before routing workspace operations.
 * Shared mode attaches to the host daemon without owning its process lifetime;
 * shutdown closes this service's clients and workers, never the shared daemon.
 * Persistent application metadata, model state and workspace files have distinct
 * storage owners; do not clear one as a shortcut for resetting another.
 */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, resolve, join } from "node:path";
import { WebSocket } from "ws";
import { rpcErrorPayload } from "../shared/bridge-errors.js";
import { sharedWorkspaceAllowed, memberApiAllowed } from "./auth/users/access.js";
import { resolvePublicAsset, unauthorizedResponse } from "./auth/security.js";
import { resolveAppServerConnection } from "./bridge/app-server-connection.js";
import { assertStartupAuth, config } from "./config.js";
import { respondJson } from "./http/respond.js";
import { createRouter } from "./http/router.js";
import { serveStaticAsset } from "./http/static-assets.js";
import { createAccountIdentityLoader, resolveAccountIdentity } from "./misc/profile.js";
import { ProjectVisibilityStore } from "./misc/project-visibility.js";
import { projectDocumentPreviewRoutes } from "./documents/preview/routes.js";
import { documentTemplateCreationRoutes } from "./templates/integration/document-creation-routes.js";
import { sourceThemeRoutes } from "./plugins/integration/source-theme-routes.js";
import { servePublicationCallback } from "./connections/integration/callback-page.js";
import { publicationOwner } from "./connections/integration/identity.js";
import { DocumentError } from "./documents/errors.js";
import { ProjectDirectoryPolicy } from "./projects/directory-policy.js";
import { ReviewDiffStore } from "./review/state.js";
import { createLocalImagePresenter } from "./workspace/image-presentation.js";
import { createImageThumbnailCache } from "./workspace/image-thumbnails.js";
import { createOssAttachmentStorage, readOssAttachmentConfig } from "./workspace/oss-attachments.js";

const initialDatabaseChoice =
  !existsSync(config.projectCatalogPath) &&
  !existsSync(join(config.stateRoot, "data", "documents.sqlite")) &&
  !existsSync(join(config.stateRoot, "data", "bot-tasks.sqlite"));
const applicationDatabase = await bootstrapApplicationDatabase(config.stateRoot, {
  initialChoiceRequired: initialDatabaseChoice,
  host: config.host,
  port: config.port,
  publicDir: config.publicDir,
  projectVisibilityPath: config.projectVisibilityPath,
});
const runtimeStores = applicationDatabase.sql
  ? await createMySQLRuntimeStores(applicationDatabase.sql, { stateRoot: config.stateRoot, homeDir: config.homeDir })
  : null;
const databaseReady = createDatabaseReadiness(applicationDatabase.sql);
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
const { authState, localAccountFeature, passwordAuth, resolveOwner } = await createApplicationAuthentication(
  config,
  runtimeStores,
  assertStartupAuth,
);
const engineImages = new EngineImages(
  join(config.stateRoot, "cache", "viewed-images"),
  [...imageRoots, ...(config.allowExternalDirectories ? ["/dev/shm"] : [])],
  (method, params) => request(method, params),
  Date.now,
  authState.secret ?? undefined,
);
const presentLocalImages = createLocalImagePresenter({
  cwd: defaultCwd,
  home: homeDir,
  allowedRoots: imageRoots,
  engineReference: (path: unknown, id: unknown) => engineImages.reference(path, id),
});
function presentBrowserData<T>(value: T): T {
  return presentLocalImages(attachmentStorage ? attachmentStorage.present(value) : value);
}

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
const projectVisibility =
  runtimeStores?.visibility ?? new ProjectVisibilityStore(config.projectVisibilityPath, homeDir);
const projects = createApplicationProjects(config, applicationDatabase.sql, runtimeStores);
const projectCatalog = projects.catalog,
  documentStorage = projects.storage;
const directoryPolicy = new ProjectDirectoryPolicy(config.projectWorkspaceRoot, config.allowExternalDirectories);
const extensions = await createApplicationExtensions(config, runtimeStores, resolveOwner);
const {
  pluginFeature,
  skillFeature,
  packageSourceFeature,
  portableTemplateFeature,
  nativeThemeFeature,
  nativeSlidesFeature,
  skillWorkspaceFeature,
  templateCatalogFeature,
  nativeSampleFeature,
  templatePreviewFeature,
} = extensions;
const originalStorageAdministrators = new Set(
  (process.env.PANDA_FORCE_STORAGE_ADMINISTRATORS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const originalStorage = createOriginalStorageFeature({
  stateRoot: config.stateRoot,
  contentRoot: config.documentContentRoot,
  privateParent: process.env.PANDA_FORCE_ORIGINAL_STORAGE_PARENT,
  authenticationConfigured: () => config.authMode !== "none" && authState.browserPasswordConfigured(),
  administrator: (context) =>
    sharedWorkspaceAllowed(context.req) &&
    (!!authState.administrator || originalStorageAdministrators.has(publicationOwner(authState, context))),
});
let searchChanged: (project: string, owner?: string) => void = () => {};
const documents = await createApplicationDocuments(
  config,
  projects,
  extensions,
  resolveOwner,
  appServerConnection.mode === "shared",
  () => (authState.administrator ? publicationOwner(authState, {}) : null),
  (project, owner) => searchChanged(project, owner),
  originalStorage,
);
const { documentFeature, fileDocuments, contentAccess, projectWorkspaces, scopedDocuments, requireDocumentProject } =
  documents;
const { editorialFeature, publishingFeature, siteBuildFeature, sitePublicationFeature, startDelivery } =
  await createApplicationPublication(config, projects, documents, extensions, resolveOwner);
const browserWire = createBrowserWire();
const clients = new Set<WebSocket>();
const sseClients = new Set<ServerResponse>();
const pendingEngineRequests = new Map<number | string, EngineEnvelope>();
let shuttingDown = false;
let shutdownExitCode = 0;
let httpClosed = false;
let finishingShutdown = false;
let backgroundStopped = false;
let activeHttpRequests = 0;
const reviewDiffs = new ReviewDiffStore();
const installedEngine = createInstalledEngine({
  id: config.engineId,
  connection: appServerConnection,
  autoContinueAfterOverload: config.autoContinueAfterOverload,
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
const { creationFeature, personalContent, readOriginalSources, knowledgeFeature, searchFeature, closeMaterialText } =
  await createApplicationContent(
    config,
    runtimeStores,
    documents,
    projects,
    extensions,
    resolveOwner,
    appServerConnection,
    () => installedEngine.request("model/list", {}),
    (context, allowlist) =>
      sharedWorkspaceAllowed(context.req) &&
      (!!authState.administrator || allowlist.includes(publicationOwner(authState, context))),
    (project, owner) => searchChanged(project, owner),
    () => (authState.administrator ? publicationOwner(authState, {}) : null),
  );
const authorizeCliProject = async (owner: string, project: string) => {
  if (owner !== publicationOwner(authState, {})) throw new DocumentError("notFound", 404);
  await contentAccess.require(owner, project, "read");
};
const botOptions = {
  stateRoot: config.stateRoot,
  version: config.version,
  connection: appServerConnection,
  owner: resolveOwner,
};
const botFeature = runtimeStores
  ? {
      ...createBotFeature({ ...botOptions, store: runtimeStores.bots }),
      storageSummary: databaseConfigurationSummary(applicationDatabase.config),
    }
  : await createConfiguredBotFeature(botOptions);
const gadgetFeature = await createGadgetFeature({
  stateRoot: config.stateRoot,
  upgradeLayout: upgradeSystemGadgetLayout,
  store: runtimeStores?.gadgets,
  owner: resolveOwner,
  modules: process.env.PANDA_FORCE_GADGET_MODULES ? JSON.parse(process.env.PANDA_FORCE_GADGET_MODULES) : [],
  register: (registry) =>
    registerSystemGadgets(
      registry,
      systemGadgetPorts({
        snapshot: () => projectCatalog.snapshot(),
        sessions: () => request("thread/list", { limit: 20 }),
        visible: (session) => directoryPolicy.remember(session),
        projectAccess: (owner, id) => contentAccess.require(owner, id, "read").then(() => {}),
        skills: templateCatalogFeature.catalog,
        bots: (owner) => botFeature.gadgetSummary(owner),
      }),
    ),
});
const databaseAdministrators = databaseAdministratorAllowlist();
const databaseManagement = createDatabaseManagementFeature({
  stateRoot: config.stateRoot,
  current: applicationDatabase.config,
  bot: botFeature.storageSummary,
  initialChoiceRequired: initialDatabaseChoice,
  owner: resolveOwner,
  administrator: (context) =>
    sharedWorkspaceAllowed(context.req) &&
    (!!authState.administrator || databaseAdministrators.has(publicationOwner(authState, context))),
  requestRestart:
    process.env.PANDA_FORCE_MANAGED_RESTART === "1" && !clusterConfig
      ? () => {
          shutdownExitCode = 75;
          shutdown();
        }
      : undefined,
});
directoryPolicy.protectSessions((id, session) => botFeature.isSession(id) || isApplicationSession(id, session));
const cliFeature = createCliFeature({
  database: runtimeStores?.cli,
  stateRoot: config.stateRoot,
  owner: resolveOwner,
  authorize: authorizeCliProject,
  commands: cliContentCommands({
    authorize: authorizeCliProject,
    originals: readOriginalSources,
    documents: async (owner, project) =>
      project === "personal" ? (await personalContent.forOwner(owner)).documents : scopedDocuments(owner, "read"),
    knowledge: knowledgeFeature.service,
    records: knowledgeFeature.records,
    search: (owner, input, signal) => searchFeature.query(owner, input, signal),
    searchStatus: (owner, project) => searchFeature.status(owner, project),
  }),
  report: () => console.warn("[cli] Client authentication is unavailable"),
});
searchChanged = (project, owner) =>
  queueMicrotask(() => {
    void searchFeature
      .changed(project, owner)
      .catch(() => console.warn("[search] A content change will be recovered by reconciliation"));
  });
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
  if (
    shuttingDown &&
    httpClosed &&
    backgroundStopped &&
    activeHttpRequests === 0 &&
    engineDriver.fullyStopped() &&
    !finishingShutdown
  ) {
    finishingShutdown = true;
    void (async () => {
      await closeApplicationStorage({
        drainCatalog: drainCatalogUpdates,
        plugins: pluginFeature,
        skills: skillFeature,
        skillWorkspace: skillWorkspaceFeature,
        gadgets: gadgetFeature,
        portable: portableTemplateFeature,
        documents: documentFeature,
        catalog: projectCatalog,
        accounts: localAccountFeature,
        database: applicationDatabase,
        cluster,
      });
      process.exit(shutdownExitCode);
    })().catch((error) => {
      console.warn("[PandaForce] Shutdown could not complete", error instanceof Error ? error.name : "unknown");
      process.exit(1);
    });
  }
}
function trackHttpRequests(handler: Parameters<typeof withRequestErrors>[0]) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    activeHttpRequests++;
    try {
      await handler(req, res);
    } finally {
      activeHttpRequests--;
      maybeFinishShutdown();
    }
  };
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
  ...(localAccountFeature?.routes ?? []),
  ...gadgetFeature.routes,
  ...contentAccess.routes,
  ...databaseManagement.routes,
  ...originalStorage.routes,
  ...botFeature.routes,
  ...cliFeature.routes,
  ...searchFeature.routes,
  ...knowledgeFeature.routes,
  ...contentSourceRoutes({ owner: resolveOwner, originals: readOriginalSources }),
  personalCopyRoute({
    personal: personalContent,
    projects: fileDocuments,
    owner: resolveOwner,
  }),
  ...personalContent.routes(),
  ...creationFeature.routes,
  ...templatePreviewFeature.routes,
  ...pluginFeature.routes,
  ...skillFeature.routes,
  ...templateCatalogFeature.routes,
  ...skillWorkspaceFeature.routes(templateCatalogFeature.catalog),
  ...portableTemplateFeature.routes,
  ...nativeThemeFeature.routes,
  ...nativeSlidesFeature.routes,
  ...nativeSampleFeature.routes,
  ...packageSourceFeature.routes,
  ...sourceThemeRoutes(documentFeature.service, resolveOwner),
  ...creativeAssetRoutes({
    owner: resolveOwner,
    canWrite: async (owner, project) => {
      try {
        await contentAccess.require(owner, project, "contribute");
        return true;
      } catch {
        return false;
      }
    },
    read: async (owner, project) => {
      await contentAccess.require(owner, project, "read");
      return project === "personal" ? personalContent.readCreations(owner) : scopedDocuments(owner, "read").creations;
    },
    write: async (owner, project) => {
      await contentAccess.require(owner, project, "contribute");
      return project === "personal"
        ? (await personalContent.forOwner(owner)).documents.creations
        : scopedDocuments(owner, "contribute").creations;
    },
  }),
  ...projectDocumentPreviewRoutes({
    fileRoutes: fileDocuments.routes,
    fileRoutesFor: (context) => {
      const documents = scopedDocuments(
        publicationOwner(authState, context),
        context.req.method === "GET" ? "read" : "contribute",
      );
      return [
        ...documents.routes,
        ...documentTemplateCreationRoutes(
          portableTemplateFeature.documents,
          documents.navigation,
          (current) => "local:" + resolveOwner(current),
        ),
      ];
    },
    authorizeProject: async (context, project) => {
      const owner = publicationOwner(authState, context),
        action = context.req.method === "GET" ? "read" : "contribute";
      if (await documentStorage.files(project)) await contentAccess.require(owner, project, action);
      else await contentAccess.requireLegacy(owner, project, action);
    },
    legacyRoutes: documents.authorizedLegacyRoutes,
    usesFiles: (id) => documentStorage.files(id),
    requireProject: requireDocumentProject,
  }),
  ...publishingFeature.routes,
  ...editorialFeature.routes,
  ...siteBuildFeature.routes,
  ...sitePublicationFeature.routes,
  ...bridgeRoutes({
    projectOwner: (context) => (authState.administrator ? publicationOwner(authState, context) : undefined),
    browserWire,
    projectless,
    defaultCwd,
    browseRoots,
    request,
    idaasAuth: null,
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
  ...engineImageRoutes(engineImages),
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

const interfaceAssets = createInterfaceAssets(publicDir);
const server = createServer(
  withRequestErrors(
    trackHttpRequests(async (req, res) => {
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
          !shuttingDown &&
          ownsWorkspace &&
          (url.pathname !== "/health/readiness" || (engineDriver.connected && (await databaseReady())));
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
      if (servePublicationCallback(req, res, url)) return;
      if (await botFeature.handle({ req, res, url })) return;
      if (await cliFeature.handle({ req, res, url })) return;
      const appRoute =
        req.method === "GET" &&
        (["/", "/invite", "/verify-email", "/reset-password", "/reset-password/new"].includes(url.pathname) ||
          /^\/(?:settings(?:\/[^/]+)?|workspace|bots(?:\/tasks|\/[a-f0-9-]{36}\/(?:chat|tasks|integrations))?|tasks|projects|project|documents|deliverables|connections|create|creation\/[^/]+|skills(?:\/[^/]+)?|publish(?:\/[^/]+)?|new|task\/[^/]+)\/?$/.test(
            url.pathname,
          ));
      const loginAssets = new Set([
        ...CREATION_STYLES,
        ...SUPPORTED_LOCALES.map((locale) => `/locales/${locale.code}.json`),
        "/",
        "/index.html",
        "/style.css",
        "/workbench.css",
        "/documents.css",
        "/creative.css",
        "/document-authoring.css",
        "/document-workspace.css",
        "/document-code.css",
        "/document-publication.css",
        "/workbench-forms.css",
        ...KNOWLEDGE_STYLES,
        ...CLI_STYLES,
        ...BOT_STYLES,
        ...DATABASE_STYLES,
        ...ORIGINAL_STORAGE_STYLES,
        ...GADGET_STYLES,
        ...GADGET_RUNTIME_ASSETS,
        "/database-maintenance.bundle.js",
        "/source-import.css",
        "/publishing.css",
        "/builds.css",
        "/delivery.css",
        "/social.css",
        "/session-workspace.css",
        "/message-composer.css",
        "/settings-workspace.css",
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
      if (await localAccountFeature?.publicHandle(req, res, url)) return;
      if (await passwordAuth.handle(req, res, url)) return;
      if (!(await passwordAuth.isAuthorized(req))) {
        if (appRoute || loginAssets.has(url.pathname)) {
          const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
          if (file) {
            serveStaticAsset(
              req,
              res,
              file,
              mime[extname(file)] || "application/octet-stream",
              interfaceAssets.get(file),
            );
            return;
          }
        }
        unauthorizedResponse(res);
        return;
      }
      if (!sharedWorkspaceAllowed(req) && !memberApiAllowed(url.pathname, req.method ?? "")) {
        respondJson(res, 403, { error: "users.workspaceRestricted" });
        return;
      }
      if (url.pathname === "/api/system/database/maintenance" && req.method === "GET") {
        const activation = await databaseManagement.state.read<{ operationId: string }>("", "activation");
        respondJson(
          res,
          200,
          { operationId: activation?.operationId ?? "", status: "complete" },
          { "cache-control": "no-store" },
        );
        return;
      }
      if (!sharedWorkspaceAllowed(req) && url.pathname === "/api/projects") {
        const access = await contentAccess.service.view(resolveOwner({ req }));
        const allowed = new Set(access.projects.map((project) => project.id));
        const snapshot = await projectCatalog.snapshot();
        respondJson(res, 200, {
          revision: snapshot.revision,
          projects: snapshot.projects
            .filter((project) => allowed.has(project.id))
            .map(({ workspace, ...project }) => {
              void workspace;
              return project;
            }),
          assignments: [],
        });
        return;
      }
      if (await dispatchApiRoute({ req, res, url })) return;
      const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      serveStaticAsset(req, res, file, mime[extname(file)] || "application/octet-stream", interfaceAssets.get(file));
    }),
  ),
);

// Bun's default keep-alive timer can close a response while it is still
// draining to a slow client. Disable it for large RPC bodies and SSE streams;
// native RPC deadlines and the reverse proxy still bound request lifetimes.
server.keepAliveTimeout = 0;

const browserConnections = installBrowserConnections({
  browserWire,
  server,
  idaasAuth: null,
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

localAccountFeature?.start();
engineDriver.start();
startDelivery();
startApplicationBackground({
  search: searchFeature,
  editorial: editorialFeature,
  creation: creationFeature,
  knowledge: knowledgeFeature,
  previews: templatePreviewFeature,
  goals: goalStore,
});
server.listen(port, host, () => {
  startApplicationIngress({
    sources: packageSourceFeature,
    themes: nativeThemeFeature,
    slides: nativeSlidesFeature,
    samples: nativeSampleFeature,
  });
  console.log(`PandaForce listening on http://${host}:${port}`);
  if (passwordAuth.passwordSetupRequired()) {
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

botFeature.start();
originalStorage.start();

function shutdown() {
  if (shuttingDown) return;
  goalStore.stop();
  siteBuildFeature.stop();
  pluginFeature.stop();
  shuttingDown = true;
  // Drain registered-client operations before closing the domain ports they use.
  void drainApplicationBackground({
    cli: cliFeature,
    bots: botFeature,
    search: searchFeature,
    closeCreativeText,
    closeMaterialText,
    originals: originalStorage,
    knowledge: knowledgeFeature,
    creation: creationFeature,
    personal: personalContent,
    publication: sitePublicationFeature,
    editorial: editorialFeature,
    previews: templatePreviewFeature,
    samples: nativeSampleFeature,
    builds: siteBuildFeature,
    themes: nativeThemeFeature,
    slides: nativeSlidesFeature,
    sources: packageSourceFeature,
  })
    .then(() => {
      backgroundStopped = true;
      maybeFinishShutdown();
    })
    .catch((error: unknown) => {
      shutdownExitCode = 1;
      console.error("[PandaForce] Background shutdown failed", error instanceof Error ? error.name : "Error");
    });
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
    process.exit(shutdownExitCode);
  }, 5000);
  forceExit.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
