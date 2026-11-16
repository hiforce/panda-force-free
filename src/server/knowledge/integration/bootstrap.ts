import type { KnowledgePersistence } from "../storage/persistence.js";
import { join, resolve } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { CodexConnection } from "../../engines/codex-transport.js";
import { isolatedApplicationEngines } from "../../engines/application-tools/factory.js";
import { applicationDefaultModel } from "../../engines/application-tools/default-model.js";
import type { KnowledgeContent } from "../tasks/contracts.js";
import { KnowledgeTaskError } from "../tasks/contracts.js";
import { knowledgeProfileSettings, disabledKnowledgeProfile, type KnowledgeProfileSettings } from "./profiles.js";
import { createKnowledgeFeature } from "./feature.js";
import { knowledgeRoutes } from "./routes.js";
import { KnowledgeRecords, unavailableApprovedKnowledge } from "../catalog/read.js";
import { knowledgeRecordRoutes } from "./record-routes.js";
import type { KnowledgeReadScope } from "../catalog/contracts.js";
import type { DocumentProjectReads } from "../../documents/files/projects.js";
import type { FileOriginalQueries } from "../../content-sources/reader.js";
import { knowledgeGenerationRoutes } from "./generation-routes.js";

export function createNativeKnowledgeFeature(
  options: {
    stateRoot: string;
    storage?: KnowledgePersistence;
    projectsRoot: string;
    engineId: string;
    connection: CodexConnection;
    version: string;
    models(): Promise<unknown>;
    content: KnowledgeContent;
    documents?(scope: KnowledgeReadScope): Promise<DocumentProjectReads>;
    indexDocuments?(scope: KnowledgeReadScope): Promise<DocumentProjectReads>;
    originals?(scope: KnowledgeReadScope): Promise<FileOriginalQueries>;
    indexOriginals?(scope: KnowledgeReadScope): Promise<FileOriginalQueries>;
    generationDocuments?(scope: KnowledgeReadScope): Promise<DocumentProjectReads>;
    initializeDocuments?(scope: KnowledgeReadScope): Promise<void>;
    owner(context: RouteContext): string;
    report(error: unknown): void;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  let settings: KnowledgeProfileSettings,
    validProfile = true;
  try {
    settings = knowledgeProfileSettings(options.stateRoot, env);
  } catch (error) {
    options.report(error);
    settings = disabledKnowledgeProfile();
    validProfile = false;
  }
  try {
    const available = () => settings.enabled && settings.engineId === options.engineId && settings.engineId === "codex",
      engines = isolatedApplicationEngines({
        connection: options.connection,
        engineId: options.engineId,
        version: options.version,
        purpose: "knowledge",
        scratchRoot: resolve(
          env.PANDA_FORCE_KNOWLEDGE_SCRATCH_DIR ||
            (options.connection.mode === "shared"
              ? join(options.projectsRoot, ".panda-force-knowledge")
              : join(options.stateRoot, "knowledge", "scratch")),
        ),
      });
    return createKnowledgeFeature({
      ...options,
      available,
      concurrency: settings.concurrency,
      generationBudget: validProfile ? settings.generationBudget : undefined,
      profile: async () => {
        if (!available()) throw new KnowledgeTaskError("unavailable");
        return {
          id: settings.id,
          engineId: settings.engineId,
          model: settings.model ?? applicationDefaultModel(await options.models()),
          activeTimeoutMs: settings.activeTimeoutMs,
        };
      },
      engine: (profile) => {
        if (!available()) throw new KnowledgeTaskError("unavailable");
        return engines.select(profile);
      },
    });
  } catch (error) {
    if (options.storage) throw error;
    options.report(error);
    const unavailable = async (): Promise<never> => {
      throw new KnowledgeTaskError("unavailable");
    };
    const service = {
      submit: unavailable,
      list: unavailable,
      history: unavailable,
      detail: unavailable,
      previous: unavailable,
      status: unavailable,
      answer: unavailable,
      edit: unavailable,
      approve: unavailable,
      cancel: unavailable,
      retry: unavailable,
    };
    const approved = unavailableApprovedKnowledge(),
      records = new KnowledgeRecords(approved);
    return {
      service,
      approved,
      indexed: approved,
      records,
      routes: [
        ...knowledgeRoutes(service, { ...options, available: () => false }),
        ...knowledgeRecordRoutes(records, { owner: options.owner, report: options.report }),
        ...knowledgeGenerationRoutes(
          {
            policy: unavailable,
            configure: unavailable,
            preview: unavailable,
            sources: unavailable,
            status: unavailable,
          },
          { ...options, available: () => false },
        ),
      ],
      start() {},
      close: async () => {},
    };
  }
}
