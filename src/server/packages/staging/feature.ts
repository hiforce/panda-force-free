import type { MetadataStore } from "../../../shared/async-value.js";
import type { SourceStageStore } from "./ports.js";
import { join } from "node:path";
import { sourceLimits, type SourceLimits } from "../../../shared/packages/sources/contracts.js";
import { LocalSourceNamespaceActivity } from "./activity.js";
import { openSourceStageDatabase } from "./database.js";
import { FileSourceStageNamespaces } from "./files.js";
import { SqliteSourceStages } from "./repository.js";
import { PackageSourceStages } from "./service.js";
import type { SourceStageCapacity } from "./records.js";
import { PackageSourceIngestion, type SourceIngestionDiagnostic } from "../ingestion/service.js";
import { PackageSourceProviders, type SourceCredentialResolver } from "../ingestion/providers.js";
import { SourceRuntime, type SourceRuntimeLimits } from "../ingestion/runtime.js";
import { BoundedSourceHttp, type SourceHttpPort } from "../source-http.js";

/** Both purposes share one file owner and reservation ledger for this application state root. */
export interface PackageSourceStageOptions<S extends MetadataStore<SourceStageStore> = SourceStageStore> {
  store?: S;
  root: string;
  limits?: SourceLimits;
  capacity?: SourceStageCapacity;
  timeoutMs?: number;
  runtime?: SourceRuntimeLimits;
  runtimePool?: SourceRuntime;
  http?: SourceHttpPort;
  credentials?: SourceCredentialResolver;
  diagnostic?: (value: SourceIngestionDiagnostic) => void;
}
export function createPackageSourceStages<S extends MetadataStore<SourceStageStore> = SourceStageStore>(
  options: PackageSourceStageOptions<S>,
) {
  if (options.store !== undefined && !options.store) throw new Error("sourceStageStorageRequired");
  const limits = sourceLimits(options.limits),
    db = options.store ? null : openSourceStageDatabase(join(options.root, "stages.sqlite"));
  try {
    const files = new FileSourceStageNamespaces(join(options.root, "content"), new LocalSourceNamespaceActivity()),
      store = (options.store ?? new SqliteSourceStages(db!, options.capacity)) as S,
      templates = new PackageSourceStages("templates", store, files, limits, Date.now, options.timeoutMs),
      skills = new PackageSourceStages("skills", store, files, limits, Date.now, options.timeoutMs),
      stages = { templates, skills },
      providers = new PackageSourceProviders(
        options.http ?? new BoundedSourceHttp(),
        (actor, purpose, id, signal) => stages[purpose].original(actor, id, signal),
        options.credentials,
      ),
      ingestion = new PackageSourceIngestion(
        stages,
        store,
        providers,
        options.runtimePool ?? new SourceRuntime(options.runtime),
        Date.now,
        options.diagnostic,
      );
    let closing: Promise<void> | undefined;
    return {
      templates,
      skills,
      ingestion,
      close: () =>
        (closing ??= (async () => {
          ingestion.stop();
          await Promise.all([templates.shutdown(), skills.shutdown(), ingestion.drain()]);
          db?.close();
        })()),
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}
