import type { MetadataStore } from "../../../shared/async-value.js";
import type { Route } from "../../http/router.js";
import type { SourceStageStore } from "../../packages/staging/ports.js";
import type { NativeThemeRegistry } from "../native/ports.js";
import type { NativeThemeServicePort } from "../native/service.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";
import { createPackageSourceStages } from "../../packages/staging/feature.js";
import type { SourceRuntime } from "../../packages/ingestion/runtime.js";
import type { TemplateSourceReader, TemplateSourceConsumer } from "../sources/ports.js";
import { openNativeThemeDatabase } from "../storage/native-database.js";
import { SqliteNativeThemes } from "../storage/native-registry.js";
import { NativeThemeService } from "../native/service.js";
import { ownedNativeSources } from "./native-sources.js";
import { nativeThemeRoutes } from "./native-routes.js";

/** Installed source ownership has its own durable ledger, while all source reads share one runtime budget. */
interface NativeOptions {
  stateRoot: string;
  owner(context: RouteContext): string;
  sourceReader: TemplateSourceReader;
  sourceConsumer: TemplateSourceConsumer;
  runtimePool: SourceRuntime;
  persistence?: { registry: MetadataStore<NativeThemeRegistry>; stages: MetadataStore<SourceStageStore> };
}
type NativeFeature<S> = { service: S; routes: Route[]; start(): void; close(): Promise<void> };
export function createNativeThemes(
  options: NativeOptions & { persistence: NonNullable<NativeOptions["persistence"]> },
): NativeFeature<NativeThemeServicePort>;
export function createNativeThemes(
  options: NativeOptions & { persistence?: undefined },
): NativeFeature<NativeThemeService>;
export function createNativeThemes(options: NativeOptions): NativeFeature<NativeThemeServicePort>;
export function createNativeThemes(options: NativeOptions) {
  if (
    options.persistence !== undefined &&
    (!options.persistence || !options.persistence.registry || !options.persistence.stages)
  )
    throw new Error("nativeTemplateStorageRequired");
  const root = join(options.stateRoot, "templates", "native"),
    sources = createPackageSourceStages({
      root: join(root, "sources"),
      runtimePool: options.runtimePool,
      store: options.persistence?.stages,
      capacity: {
        ownerBytes: 512 * 1024 * 1024,
        globalBytes: 2 * 1024 * 1024 * 1024,
        ownerItems: 1024,
        globalItems: 2048,
      },
    });
  let db: ReturnType<typeof openNativeThemeDatabase> | null = null;
  try {
    db = options.persistence ? null : openNativeThemeDatabase(join(root, "registry.sqlite"));
  } catch (error) {
    void sources.close().catch((failure) => reportDiagnostic("native-theme-source-close", failure));
    throw error;
  }
  const service = new NativeThemeService(
    options.persistence?.registry ?? new SqliteNativeThemes(db!),
    ownedNativeSources(sources.templates, sources.ingestion),
    options.sourceReader,
    options.sourceConsumer,
  );
  let timer: ReturnType<typeof setInterval> | undefined,
    recovering: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  function poll() {
    if (recovering || closing) return;
    recovering = service
      .recover()
      .catch((error: unknown) => reportDiagnostic("native-theme-recovery", error))
      .finally(() => {
        recovering = undefined;
      });
  }
  return {
    service,
    routes: nativeThemeRoutes(service, options.owner),
    start() {
      if (!timer && !closing) {
        poll();
        timer = setInterval(poll, 10000);
        timer.unref();
      }
    },
    close() {
      return (closing ??= (async () => {
        clearInterval(timer);
        await service.close();
        await sources.close();
        db?.close();
      })());
    },
  };
}
