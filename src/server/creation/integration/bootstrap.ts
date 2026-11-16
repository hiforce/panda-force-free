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
    owner(context: RouteContext): string;
    requireProject(projectId: string): unknown;
    authorizeProject?(owner: string, projectId: string): void | Promise<void>;
    documents: CreationDocumentPort;
    skills: SkillCatalog;
    storage?: Parameters<typeof createCreationFeature>[0]["storage"];
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  const settings = creationProfileSettings(options.profileStateRoot ?? options.stateRoot, env);
  if (settings.invalid) reportDiagnostic("creation-configuration", new CreationError("invalidInput"));
  try {
    return createCreationFeature({
      ...options,
      authorize: async (owner, projectId) => {
        try {
          await options.requireProject(projectId);
          await options.authorizeProject?.(owner, projectId);
        } catch {
          throw new CreationError("notFound");
        }
      },
      profiles: new CreationProfiles(settings, new Set(options.engineId === "codex" ? ["codex"] : []), async () =>
        creationDefaultModel(await options.models()),
      ),
      engines: creationEngines({
        ...options,
        scratchRoot: resolve(
          env.PANDA_FORCE_CREATION_SCRATCH_DIR ||
            (options.connection.mode === "shared"
              ? join(options.projectsRoot, ".panda-force-creation")
              : join(options.stateRoot, "creation", "scratch")),
        ),
      }),
    });
  } catch (error) {
    reportDiagnostic("creation-startup", error);
    const unavailable = async (): Promise<never> => {
      throw new CreationError("unavailable");
    };
    // An optional execution ledger must not prevent ordinary document editing or authentication from starting.
    return {
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
