import type { ProjectSessionBinding, ProjectSessionMembership } from "../projects/session-membership.js";
import { ProjectMemoryMaterialSearch } from "../project-memory/material-search.js";
import { HarnessMaterials } from "./materials.js";
import { harnessConversationId, harnessSummary } from "../../shared/harness/presentation.js";
import { errorCode } from "../../shared/errors.js";
import type { CreationMaterialPort } from "../creation/materials.js";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { HarnessError } from "../../shared/harness/contracts.js";
import { isRecord } from "../../shared/records.js";
import type { HarnessMetadata } from "./ports.js";
import type { EngineDriver } from "../../shared/engine/contracts.js";
import type { SessionHistory } from "../engines/runtime-contract.js";
import type { ProjectDirectoryPolicy } from "../projects/directory-policy.js";
import type { RouteContext } from "../http/router.js";
import { sharedWorkspaceAllowed } from "../auth/users/access.js";
import { SQLiteHarnessMetadata } from "./storage/sqlite.js";
import { HarnessHistoryMaintenance } from "./storage/history-maintenance.js";
import { JsonlHarnessHistory } from "./storage/history.js";
import { HarnessRegistry, type HarnessPrincipal } from "./registry.js";
import { HarnessConversations } from "./conversations.js";
import { HarnessDiagnostics } from "./diagnostics.js";
import { harnessProfiles } from "./profiles.js";
import { harnessRoutes } from "./routes.js";
import { readHarnessSourcePage } from "./source-history.js";
import { ensureAttachmentWorkspace } from "../workspace/attachment-workspace.js";
import { attachmentWorkspaceContext } from "../../shared/attachment-workspace.js";
import { createHarnessWorkspace } from "./workspaces.js";
import { ProjectMemory } from "../project-memory/service.js";
import type { MemoryArchiveAuthorize } from "../project-memory/portability.js";
import { RemoteMemoryPackages } from "../project-memory/pmf-remote.js";
import type { OriginalStorageConfiguration } from "../object-storage/configuration.js";
import type { MemoryMaterialStore } from "../project-memory/materials.js";
import { MemoryMaterialPreviews } from "../project-memory/material-previews.js";
import { MemoryMaterialVisuals } from "../project-memory/material-visuals.js";
import { MemoryNativeCopies } from "../project-memory/native-copies.js";
import { projectMemoryRoutes } from "../project-memory/routes.js";
import { NativeMemoryJournal } from "../project-memory/native-journal.js";
import { legacyMemoryRoute } from "../project-memory/legacy.js";
import type { ModelReviewPort } from "../project-memory/model-review.js";
import type { MemorySearchProviders } from "../project-memory/search-index.js";
export async function createHarnessFeature(options: {
  stateRoot: string;
  defaultCwd: string;
  browseRoots: readonly string[];
  driver: EngineDriver;
  nativeHistory: SessionHistory;
  metadata?: HarnessMetadata;
  materials(): CreationMaterialPort;
  remoteMaterial?(url: string): Promise<{ bytes: Uint8Array; canonicalUrl: string }>;
  directoryPolicy: ProjectDirectoryPolicy;
  owner(context: RouteContext): string;
  project(owner: string, project: string): Promise<{ path: string }>;
  authorizeProject: MemoryArchiveAuthorize;
  sessionMembership(id: string): Promise<ProjectSessionMembership | null>;
  bindSession(project: string, session: ProjectSessionBinding): Promise<void>;
  memoryModels?: ModelReviewPort;
  memorySearch?: MemorySearchProviders;
  memoryMaterials?: MemoryMaterialStore;
  memoryCopyDestination?: ConstructorParameters<typeof MemoryNativeCopies>[1];
  memoryPackageStorage?: Pick<OriginalStorageConfiguration, "memoryPackageTarget" | "memoryPackagesEnabled" | "client">;
}) {
  const metadata = options.metadata ?? new SQLiteHarnessMetadata(join(options.stateRoot, "data", "harness.sqlite"));
  const registry = new HarnessRegistry(metadata, harnessProfiles(options.stateRoot, options.driver));
  await registry.initialize();
  const principal = (context: RouteContext): HarnessPrincipal => ({
    owner: options.owner(context),
    administrator: sharedWorkspaceAllowed(context.req),
  });
  // Native execution IDs remain hidden after a restart as well as while the process that created them is alive.
  const { rememberApplicationSession } = await import("../engines/application-tools/sessions.js");
  for (const row of await metadata.list("conversation")) {
    const value: unknown = JSON.parse(row.data);
    if (isRecord(value) && Array.isArray(value.bindings))
      for (const binding of value.bindings)
        if (isRecord(binding) && typeof binding.nativeSessionId === "string")
          rememberApplicationSession(binding.nativeSessionId);
  }
  const materials = new HarnessMaterials({
    roots: options.browseRoots,
    allows: (path) => options.directoryPolicy.allowsPath(path),
    materials: options.materials,
    remote: options.remoteMaterial,
  });
  const history = new JsonlHarnessHistory(join(options.stateRoot, "harness", "conversations"));
  const historyMaintenance = new HarnessHistoryMaintenance(metadata, history);
  const memory = new ProjectMemory(
    metadata,
    history,
    async (source, access) => {
      if (!source.projectId) throw new HarnessError("notFound", 404);
      await options.authorizeProject(source.owner, source.projectId, access);
    },
    (cwd) => options.directoryPolicy.allowsPath(cwd),
    Date.now,
    (id) => options.sessionMembership(harnessConversationId(id)),
    options.memoryModels,
    options.memorySearch,
    options.memorySearch && options.memoryMaterials
      ? new ProjectMemoryMaterialSearch(
          metadata,
          options.memorySearch.local,
          options.memoryMaterials,
          options.authorizeProject,
        )
      : undefined,
    options.sessionMembership,
    options.authorizeProject,
  );
  const nativeMemory = new NativeMemoryJournal(metadata, history, memory);
  const remotePackages = options.memoryPackageStorage
    ? new RemoteMemoryPackages(metadata, options.memoryPackageStorage, options.authorizeProject)
    : undefined;
  const memoryPreviews = new MemoryMaterialPreviews();
  const conversations = new HarnessConversations({
    metadata,
    history,
    memory,
    memoryVisuals: options.memoryMaterials && new MemoryMaterialVisuals(options.memoryMaterials, memoryPreviews),
    bindProject: options.bindSession,
    registry,
    sourcePage: async (principal, id, cursor) => {
      if (!principal.administrator) throw new HarnessError("forbidden", 403);
      const native = await options.nativeHistory.getThreadMetadata(id);
      const cwd = native.cwd || options.defaultCwd;
      if (!options.directoryPolicy.remember(native) || !options.directoryPolicy.allowsPath(cwd))
        throw new HarnessError("forbidden", 403);
      return readHarnessSourcePage(options.nativeHistory, id, cwd, cursor);
    },
    historyCommand: [
      process.execPath,
      existsSync(join(import.meta.dir, "history-cli.ts"))
        ? join(import.meta.dir, "history-cli.ts")
        : join(dirname(process.argv[1] || process.execPath), "harness-history.js"),
    ],
    workspace: async (principal, input) => {
      if (!principal.administrator) throw new HarnessError("forbidden", 403);
      let path = input.cwd || options.defaultCwd;
      if (input.projectId) path = (await options.project(principal.owner, input.projectId)).path;
      if (!options.directoryPolicy.allowsPath(path) || !(await stat(path)).isDirectory())
        throw new HarnessError("workspaceUnavailable", 409);
      return realpath(path);
    },
    authorize: async (principal, conversation) => {
      if (!principal.administrator || !options.directoryPolicy.allowsPath(conversation.cwd))
        throw new HarnessError("forbidden", 403);
      if (conversation.projectId) await options.authorizeProject(principal.owner, conversation.projectId);
    },
    attachments: (principal, ids, conversation) => materials.resolve(principal, ids, conversation),
    instructions: (conversation) =>
      `${attachmentWorkspaceContext(ensureAttachmentWorkspace(conversation.cwd, options.browseRoots, conversation.id))}\n\n`,
  });
  const workspace = (prefix: string, shared: boolean) => {
    if (!options.directoryPolicy.allowsPath(options.defaultCwd)) throw new HarnessError("forbidden", 403);
    return createHarnessWorkspace(options.defaultCwd, prefix, shared);
  };
  const diagnostics = new HarnessDiagnostics(registry, (runtime) =>
    workspace(".panda-harness-ping-", registry.usesHostSocket(runtime.profileId)),
  );
  const routes = harnessRoutes({
    registry,
    conversations,
    diagnostics,
    principal,
    defaultCwd: options.defaultCwd,
    importSession: async (principal, id) => {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new HarnessError("invalidInput");
      const native = await options.nativeHistory.getThreadMetadata(id);
      if (!options.directoryPolicy.remember(native)) throw new HarnessError("notFound", 404);
      const live = await options.nativeHistory.readLiveThread(id);
      if (isRecord(live) && live.active === true) throw new HarnessError("busy", 409);
      const cwd = native.cwd || options.defaultCwd;
      if (!options.directoryPolicy.allowsPath(cwd)) throw new HarnessError("forbidden", 403);
      return readHarnessSourcePage(options.nativeHistory, id, cwd);
    },
  });
  return {
    startProjectMemory: () => {
      memory.start();
      historyMaintenance.start();
      remotePackages?.start();
    },
    registry,
    conversations,
    projectMemory: memory,
    nativeMemory,
    hostCatalogWorkspace: () => workspace(".panda-harness-catalog-", true),
    projectSessions: {
      get: (context: RouteContext, id: string) => conversations.summary(principal(context), id),
      withAssignmentCheckpoints: <T>(
        context: RouteContext,
        ids: readonly string[],
        commit: (sessions: readonly ProjectSessionBinding[]) => Promise<T>,
      ) => conversations.withAssignmentCheckpoints(principal(context), ids, commit),
      list: async (context: RouteContext) => {
        let identity: HarnessPrincipal;
        try {
          identity = principal(context);
        } catch (error) {
          // Legacy service-only installations have native projects but no personal conversation owner yet.
          if (errorCode(error) === "identityRequired") return [];
          throw error;
        }
        return (await conversations.list(identity)).map(harnessSummary);
      },
    },
    routes: [
      ...routes,
      legacyMemoryRoute({
        memory,
        journal: nativeMemory,
        principal,
        authorize: options.authorizeProject,
        membership: options.sessionMembership,
        history: options.nativeHistory,
        directory: options.directoryPolicy,
      }),
      ...projectMemoryRoutes({
        memory,
        principal,
        authorize: options.authorizeProject,
        remotePackages,
        materials: options.memoryMaterials,
        previews: memoryPreviews,
        copies: options.memoryCopyDestination && new MemoryNativeCopies(metadata, options.memoryCopyDestination),
      }),
    ],
    async close() {
      await diagnostics.close();
      await conversations.close();
      await nativeMemory.close();
      await memory.close();
      await historyMaintenance.close();
      await remotePackages?.close();
      await metadata.close();
    },
  };
}
