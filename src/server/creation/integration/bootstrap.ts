import { join, resolve } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { CodexConnection } from "../../engines/codex-transport.js";
import type { CreationDocumentPort } from "./document-port.js";
import type { SkillCatalog } from "../../skills/catalog/service.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { CreationError } from "../contracts.js";
import { applicationDefaultModel } from "../../engines/application-tools/default-model.js";
import { createCreationFeature } from "./feature.js";
import { CreationProfiles, creationProfileSettings } from "./profiles.js";
import { creationEngines } from "./engines.js";
import { creationRoutes } from "./routes.js";
import { ImageRenderJournal } from "./rendering/image-journal.js";
import { NativeImageRenderer } from "./rendering/native-image.js";
import { CreationGeneratedOriginals } from "./rendering/generated-originals.js";
import { nativeCreationGenerators } from "./rendering/generators.js";
import { NativeCreationVideoRenderer } from "./rendering/native-video.js";

/** Resolve only the engine's advertised default; retries retain this exact model in their immutable input. */
export function creationDefaultModel(value: unknown): string {
  try {
    return applicationDefaultModel(value);
  } catch {
    throw new CreationError("unavailable");
  }
}
export function createNativeCreationFeature(
  options: {
    stateRoot: string;
    profileStateRoot?: string;
    projectsRoot: string;
    engineId: string;
    connection: CodexConnection;
    version: string;
    models(): Promise<unknown>;
    runtimes?: import("../../engines/application-tools/runtime-port.js").ApplicationRuntimePort;
    owner(context: RouteContext): string;
    requireProject(projectId: string): unknown;
    authorizeProject?(owner: string, projectId: string): void | Promise<void>;
    documents: CreationDocumentPort;
    archive?: import("./document-archive.js").CreationDocumentArchive;
    destinations?: import("../document-destinations.js").CreationDocumentDestinations;
    directories?: import("../file-directories.js").CreationFileDirectories;
    skills: SkillCatalog;
    materials?: import("../materials.js").CreationMaterialPort;
    assets?: import("./media-output.js").CreationAssetAccess;
    storage?: Parameters<typeof createCreationFeature>[0]["storage"];
    media?: Pick<import("../media-executors/contracts.js").CreationMediaExecutorPort, "bind">;
    mediaJobs?: import("./media-executors/jobs.js").CreationMediaJobs;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  const settings = creationProfileSettings(options.profileStateRoot ?? options.stateRoot, env);
  const scratchRoot = resolve(
      env.PANDA_FORCE_CREATION_SCRATCH_DIR ||
        (options.connection.mode === "shared"
          ? join(options.projectsRoot, ".panda-force-creation")
          : join(options.stateRoot, "creation", "scratch")),
    ),
    workspaceRoot = resolve(
      env.PANDA_FORCE_CREATION_WORKSPACE_DIR ||
        (options.connection.mode === "shared"
          ? join(options.projectsRoot, ".panda-force-creation", "workspaces")
          : join(options.stateRoot, "creation", "workspaces")),
    );
  if (settings.invalid) reportDiagnostic("creation-configuration", new CreationError("invalidInput"));
  try {
    const journal =
        options.assets && options.engineId === "codex"
          ? new ImageRenderJournal(join(options.stateRoot, "creation", "image-renders"))
          : undefined,
      renderer = journal
        ? new NativeImageRenderer(journal, { connection: options.connection, scratchRoot, version: options.version })
        : undefined;
    return createCreationFeature({
      ...options,
      enforceMediaSelection: true,
      workspaceRoot,
      ...(journal && renderer && options.assets
        ? {
            image: {
              applicationImages: options.runtimes,
              mediaJobs: options.mediaJobs,
              journal,
              renderer,
              assets: options.assets,
              available: () => renderer.available(),
              generated: new CreationGeneratedOriginals(join(options.stateRoot, "creation", "generated-originals")),
              generators: nativeCreationGenerators(
                new NativeCreationVideoRenderer(join(options.stateRoot, "creation", "video-renders"), env),
              ),
            },
          }
        : {}),
      authorize: async (owner, projectId) => {
        try {
          await options.requireProject(projectId);
          await options.authorizeProject?.(owner, projectId);
        } catch {
          throw new CreationError("notFound");
        }
      },
      profiles: new CreationProfiles(
        settings,
        new Set(options.engineId === "codex" ? ["codex"] : []),
        async (_engineId, catalog) => creationDefaultModel(catalog ?? (await options.models())),
        options.models,
        options.runtimes,
      ),
      engines: creationEngines({
        ...options,
        scratchRoot,
        workspaceRoot,
      }),
    });
  } catch (error) {
    reportDiagnostic("creation-startup", error);
    const unavailable = async (): Promise<never> => {
      throw new CreationError("unavailable");
    };
    // An optional execution ledger must not prevent ordinary document editing or authentication from starting.
    return {
      service: undefined,
      creationCapabilities: undefined,
      recoverMedia: async () => false,
      routes: creationRoutes(
        {
          options: async () => ({
            state: "unavailable",
            profiles: [],
            defaultProfileId: null,
            defaultWorkflow: null,
            capabilities: [],
          }),
          submit: unavailable,
          followUp: unavailable,
          list: unavailable,
          detail: unavailable,
          cancel: unavailable,
          retry: unavailable,
          answer: unavailable,
        },
        options.owner,
      ),
      start() {},
      close: async () => {},
    };
  }
}
