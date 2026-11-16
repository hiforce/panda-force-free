import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import { createPackageSourceStages } from "../../src/server/packages/staging/feature.js";
import { openZipSource } from "../../src/server/packages/zip/source.js";
import { captureSourceSnapshot, type CapturedPackageSource } from "../../src/shared/packages/sources/snapshot.js";
import { openNativeThemeDatabase } from "../../src/server/templates/storage/native-database.js";
import { SqliteNativeThemes } from "../../src/server/templates/storage/native-registry.js";
import { NativeThemeService } from "../../src/server/templates/native/service.js";
import { ownedNativeSources } from "../../src/server/templates/integration/native-sources.js";
import type { NativeThemeRegistry, NativeThemeSources } from "../../src/server/templates/native/ports.js";
import type { NativeThemeSettings } from "../../src/shared/templates/native/contracts.js";

export const nativeSettings = (version = "1.0.0"): NativeThemeSettings => ({
  schema: 1,
  id: "example.native",
  version,
  name: { en: "Native theme" },
  description: { en: "A native fixture" },
  publisher: "Example",
  license: { expression: "MIT", file: "LICENSE" },
  readme: "README.md",
  engine: "hexo",
  entry: null,
  dependencies: {},
});
export const nativeFiles = {
  LICENSE: "MIT fixture license",
  "README.md": "Native theme usage",
  "private.txt": "Owner-only original resource",
  "theme/layout/index.ejs": "<h1><%= page.title %></h1>",
  "theme/source/logo.bin": new Uint8Array([0, 10, 255]),
};
export async function nativeZipSource(files: Record<string, string | Uint8Array> = nativeFiles) {
  const bytes = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, data]) => [
          path,
          typeof data === "string" ? new TextEncoder().encode(data) : data,
        ]),
      ),
    ),
    reader = await openZipSource(bytes, "native-theme.zip");
  return { bytes, reader, source: await captureSourceSnapshot(reader, undefined, bytes) };
}

export async function nativeThemeFixture(
  options: { ownedCapacity?: Parameters<typeof createPackageSourceStages>[0]["capacity"] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "panda-native-themes-")),
    services = new Set<NativeThemeService>();
  let now = Date.now();
  const open = () => {
    const intake = createPackageSourceStages({ root: join(root, "intake") }),
      owned = createPackageSourceStages({
        root: join(root, "owned"),
        runtimePool: intake.ingestion.runtime,
        capacity: options.ownedCapacity,
      }),
      db = openNativeThemeDatabase(join(root, "native.sqlite"));
    return { intake, owned, db };
  };
  let storage = open();
  async function closeStorage() {
    await Promise.all([...services].map((service) => service.close()));
    services.clear();
    await storage.owned.close();
    await storage.intake.close();
    storage.db.close();
  }
  function service(
    override: {
      sources?: (value: NativeThemeSources) => NativeThemeSources;
      registry?: (value: NativeThemeRegistry) => NativeThemeRegistry;
    } = {},
  ) {
    const registry = new SqliteNativeThemes(storage.db, () => now),
      sources = ownedNativeSources(storage.owned.templates, storage.owned.ingestion),
      value = new NativeThemeService(
        override.registry?.(registry) ?? registry,
        override.sources?.(sources) ?? sources,
        { project: (actor, id, read) => storage.intake.ingestion.project(actor, "templates", id, read) },
        { consume: (actor, id, sha, run) => storage.intake.ingestion.consume(actor, "templates", id, sha, run) },
        () => now,
      );
    services.add(value);
    return value;
  }
  return {
    root,
    service,
    get db() {
      return storage.db;
    },
    get intake() {
      return storage.intake;
    },
    get owned() {
      return storage.owned;
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    async stage(source: CapturedPackageSource, actor = "owner") {
      const origin = source.descriptor.origin,
        request =
          origin.kind === "zip-upload"
            ? {
                kind: "zip-upload",
                name: origin.name,
                bytes: source.descriptor.archiveBytes,
                sha256: origin.archiveSha256,
              }
            : {
                kind: "github",
                repository: origin.repository,
                repositoryId: origin.repositoryId,
                ref: origin.requestedRef,
                root: origin.root,
              },
        stage = await storage.intake.templates.submit(actor, randomUUID(), {
          source: request,
          selected: [...source.tree.files, ...(source.links?.files ?? [])].map((file) => file.path).sort(),
        });
      return storage.intake.templates.execute(actor, stage.id, stage.revision, async () => source);
    },
    async command(
      value: NativeThemeService,
      source: CapturedPackageSource,
      settings = nativeSettings(),
      actor = "owner",
    ) {
      const stage = await this.stage(source, actor),
        reference = { source: { id: stage.id, sha256: stage.digest!, root: "theme" }, settings },
        review = await value.review(actor, reference);
      return {
        stage,
        review,
        input: {
          ...reference,
          approval: {
            operationId: randomUUID(),
            expectedRevision: review.revision,
            reviewHash: review.reviewHash,
            permissions: ["build:theme-code"],
            licenseAcknowledged: true,
          },
        },
      };
    },
    async restart() {
      await closeStorage();
      storage = open();
      return service();
    },
    async close() {
      await closeStorage();
      await rm(root, { recursive: true, force: true });
    },
  };
}
