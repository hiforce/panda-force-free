import type { MetadataStore } from "../../../shared/async-value.js";
import type { Route } from "../../http/router.js";
import type { SourceStageStore } from "../../packages/staging/ports.js";
import type { NativeSlidesRegistry } from "../../slides/templates/ports.js";
import type { NativeSlidesServicePort } from "../../slides/templates/service.js";
import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import type { CapturedSourceReader, CapturedSourceConsumer } from "../../../shared/packages/ownership.js";
import type { SourceRuntime } from "../../packages/ingestion/runtime.js";
import { createPackageSourceStages } from "../../packages/staging/feature.js";
import { ownedStagedSources } from "../../packages/ownership/staged.js";
import { NativeSlidesContent } from "../../slides/templates/content.js";
import { NativeSlidesService } from "../../slides/templates/service.js";
import { SqliteNativeSlides, openNativeSlidesDatabase } from "../../slides/storage/registry.js";
import { nativeSlidesRoutes } from "./native-slides-routes.js";
import { reportDiagnostic } from "../../../shared/diagnostics.js";

/** Office state and files are independent of site themes; both use the same neutral ownership and version mechanisms. */
interface NativeOptions {
  stateRoot: string;
  owner(context: RouteContext): string;
  sourceReader: CapturedSourceReader;
  sourceConsumer: CapturedSourceConsumer;
  runtimePool: SourceRuntime;
  persistence?: { registry: MetadataStore<NativeSlidesRegistry>; stages: MetadataStore<SourceStageStore> };
}
type NativeFeature<S> = { service: S; routes: Route[]; start(): void; close(): Promise<void> };
export function createNativeSlidesTemplates(
  options: NativeOptions & { persistence: NonNullable<NativeOptions["persistence"]> },
): NativeFeature<NativeSlidesServicePort>;
export function createNativeSlidesTemplates(
  options: NativeOptions & { persistence?: undefined },
): NativeFeature<NativeSlidesService>;
export function createNativeSlidesTemplates(options: NativeOptions): NativeFeature<NativeSlidesServicePort>;
export function createNativeSlidesTemplates(options: NativeOptions) {
  if (
    options.persistence !== undefined &&
    (!options.persistence || !options.persistence.registry || !options.persistence.stages)
  )
    throw new Error("nativeTemplateStorageRequired");
  const root = join(options.stateRoot, "templates", "native-slides");
  const sources = createPackageSourceStages({
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
  let db: ReturnType<typeof openNativeSlidesDatabase> | null = null;
  try {
    db = options.persistence ? null : openNativeSlidesDatabase(join(root, "registry.sqlite"));
  } catch (error) {
    void sources.close().catch((failure) => reportDiagnostic("native-slides-source-close", failure));
    throw error;
  }
  const service = new NativeSlidesService(
    options.persistence?.registry ?? new SqliteNativeSlides(db!),
    new NativeSlidesContent(ownedStagedSources(sources.templates, sources.ingestion)),
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
      .catch((error) => reportDiagnostic("native-slides-recovery", error))
      .finally(() => {
        recovering = undefined;
      });
  }
  return {
    service,
    routes: nativeSlidesRoutes(service, options.owner),
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
