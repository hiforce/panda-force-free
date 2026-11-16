import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CapturedPackageSource } from "../../src/shared/packages/sources/snapshot.js";
import type { SourceStageCapacity } from "../../src/server/packages/staging/records.js";
import { createPackageSourceStages } from "../../src/server/packages/staging/feature.js";
import { ownedStagedSources } from "../../src/server/packages/ownership/staged.js";
import { NativeSlidesContent } from "../../src/server/slides/templates/content.js";
import { NativeSlidesService } from "../../src/server/slides/templates/service.js";
import { openNativeSlidesDatabase, SqliteNativeSlides } from "../../src/server/slides/storage/registry.js";
import type { NativeSlidesBodyStore, NativeSlidesRegistry } from "../../src/server/slides/templates/ports.js";
import { nativeSlidesFixture } from "./native-slides.js";
import { captureNativeSlidesBundle } from "../../src/server/slides/templates/bundle.js";

export async function nativeSlidesRegistryFixture(capacity?: SourceStageCapacity) {
  const root = await mkdtemp(join(tmpdir(), "panda-slides-registry-")),
    services = new Set<NativeSlidesService>();
  let now = Date.now();
  const open = () => {
    const intake = createPackageSourceStages({ root: join(root, "intake") }),
      owned = createPackageSourceStages({ root: join(root, "owned"), capacity, runtimePool: intake.ingestion.runtime }),
      db = openNativeSlidesDatabase(join(root, "registry.sqlite"));
    return { intake, owned, db };
  };
  let storage = open();
  async function close() {
    await Promise.all([...services].map((s) => s.close()));
    services.clear();
    await storage.owned.close();
    await storage.intake.close();
    storage.db.close();
  }
  function service(
    override: {
      bodies?: (base: NativeSlidesBodyStore) => NativeSlidesBodyStore;
      registry?: (base: NativeSlidesRegistry) => NativeSlidesRegistry;
    } = {},
  ) {
    const registry = new SqliteNativeSlides(storage.db, () => now),
      content = new NativeSlidesContent(ownedStagedSources(storage.owned.templates, storage.owned.ingestion)),
      base: NativeSlidesBodyStore = {
        put: (actor, id, t) => content.put(actor, id, t),
        with: (actor, ref, run) => content.with(actor, ref, run),
        recover: (actor, id) => content.recover(actor, id),
        reference: (actor, id) => content.reference(actor, id),
        remove: (actor, id) => content.remove(actor, id),
      },
      value = new NativeSlidesService(
        override.registry?.(registry) ?? registry,
        override.bodies?.(base) ?? base,
        { project: (actor, id, read) => storage.intake.ingestion.project(actor, "templates", id, read) },
        { consume: (actor, id, sha, run) => storage.intake.ingestion.consume(actor, "templates", id, sha, run) },
        () => now,
      );
    services.add(value);
    return value;
  }
  async function stage(source: CapturedPackageSource, actor = "owner") {
    const origin = source.descriptor.origin,
      request = {
        source:
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
        selected: source.tree.files.map((file) => file.path),
      },
      first = await storage.intake.templates.submit(actor, randomUUID(), request),
      ready = await storage.intake.templates.execute(actor, first.id, first.revision, async () => source);
    if (ready.state !== "ready") throw Error("Fixture intake failed");
    return ready;
  }
  return {
    root,
    service,
    stage,
    advance: (ms: number) => {
      now += ms;
    },
    get registry() {
      return new SqliteNativeSlides(storage.db, () => now);
    },
    get intake() {
      return storage.intake;
    },
    get owned() {
      return storage.owned;
    },
    get db() {
      return storage.db;
    },
    async command(version = "1.0.0", actor = "owner") {
      const fixture = await nativeSlidesFixture(version),
        source = await captureNativeSlidesBundle(fixture.template),
        staged = await stage(source, actor);
      return {
        ...fixture,
        captured: source,
        staged,
        input: {
          source: { id: staged.id, sha256: source.digest, selection: { kind: "bundle" as const, root: "" } },
          definition: null,
        },
      };
    },
    async approve(api: NativeSlidesService, input: unknown, actor = "owner") {
      const review = await api.review(actor, input);
      return {
        operationId: randomUUID(),
        expectedRevision: review.revision,
        reviewHash: review.reviewHash,
        licenseAcknowledged: true as const,
      };
    },
    async restart() {
      await close();
      storage = open();
    },
    async cleanup() {
      await close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
