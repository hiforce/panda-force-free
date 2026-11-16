import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isolatedMySQLDatabase } from "../support/mysql-database.js";
import { createMySQLExtensionStores, mySQLExtensionPersistence } from "../../src/server/database/extension-stores.js";
import { mysqlPluginsModule } from "../../src/server/database/modules/plugins.js";
import { mysqlTemplatesModule } from "../../src/server/database/modules/templates.js";
import { mysqlPackageSourcesModule } from "../../src/server/database/modules/package-sources.js";
import { mysqlBuildsModule } from "../../src/server/database/modules/builds.js";
import { mysqlPublishingModule } from "../../src/server/database/modules/publishing.js";
import { createPluginFeature } from "../../src/server/plugins/integration/feature.js";
import { createPortableTemplates } from "../../src/server/templates/integration/portable-feature.js";
import { createNativeThemes } from "../../src/server/templates/integration/native-feature.js";
import { createNativeSlidesTemplates } from "../../src/server/templates/integration/native-slides-feature.js";
import { createNativeSampleFeature } from "../../src/server/templates/integration/native-build-feature.js";
import { createSiteBuildFeature } from "../../src/server/builds/integration/feature.js";
import { createPackageSourceFeature } from "../../src/server/package-sources/feature.js";
import { createTemplateCatalogFeature } from "../../src/server/templates/integration/feature.js";
import { createPublishingFeature } from "../../src/server/publishing/integration/feature.js";
import { PublicationVariantFiles } from "../../src/server/publishing/variant-files.js";
import { nativeBuildThemes } from "../../src/server/templates/integration/native-build-themes.js";
import { SourceRuntime } from "../../src/server/packages/ingestion/runtime.js";
import { createRouter, type Route } from "../../src/server/http/router.js";
import { exampleThemePackage } from "../support/theme-package.mjs";
import { exampleTemplateDefinition } from "../support/template-definition.mjs";
import { portableFixture, fixtureBytes } from "../support/portable-templates.js";
import { PortableTemplateSource } from "../../src/server/templates/portable/source.js";
import { nativeZipSource, nativeSettings } from "../support/native-theme.js";
import { nativeSlidesFixture } from "../support/native-slides.js";
import { captureNativeSlidesBundle } from "../../src/server/slides/templates/bundle.js";
import { SampleExecutor } from "../support/site-sample-fixture.js";
import { ResourceBuildRequest } from "../../src/shared/builds/resources.js";
import type { BuildExecution } from "../../src/shared/builds/contracts.js";
import { CapturedPackageSource } from "../../src/shared/packages/sources/snapshot.js";
import { createPackageSourceStages } from "../../src/server/packages/staging/feature.js";
import { NativeThemeError } from "../../src/shared/templates/native/contracts.js";
import type { NativeThemeRegistry } from "../../src/server/templates/native/ports.js";
import type { MetadataStore } from "../../src/shared/async-value.js";
import sharp from "sharp";

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean) {
  const limit = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw Error("Fixture condition timed out");
    await Bun.sleep(50);
  }
}
class FixtureExecutor extends SampleExecutor {
  constructor() {
    super();
    this.available.nativeResources = true;
  }
  async startResource(id: string, input: ResourceBuildRequest) {
    this.starts++;
    let row = this.remote.get(id);
    if (!row) {
      row = {
        id,
        inputHash: input.digest,
        engine: input.engine,
        phase: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        image: { reference: "fixture.invalid/native:1", id: "sha256:" + "a".repeat(64), digest: null },
      } as BuildExecution;
      this.remote.set(id, row);
    }
    if (this.loseResponse) {
      this.loseResponse = false;
      throw Error("simulatedLostAcknowledgement");
    }
    return this.status(id);
  }
}

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "native extension consumers and HTTP routes use injected stores through review, source ownership, builds, replay and async authorization",
  async () => {
    const database = await isolatedMySQLDatabase("consumers"),
      root = await mkdtemp(join(tmpdir(), "mysql-extension-consumers-")),
      closers: Array<() => Promise<unknown> | void> = [];
    let server: ReturnType<typeof createServer> | undefined;
    try {
      // Schema/DDL parity has its own completed baseline. This run targets application consumers only.
      for (const module of [
        mysqlPluginsModule,
        mysqlTemplatesModule,
        mysqlPackageSourcesModule,
        mysqlBuildsModule,
        mysqlPublishingModule,
      ])
        for (const migration of module.migrations.mysql!)
          for (const step of migration.steps) await database.sql.unsafe(step.sql);
      const stores = createMySQLExtensionStores(database.sql),
        storage = mySQLExtensionPersistence(stores),
        executor = new FixtureExecutor(),
        runtime = new SourceRuntime(),
        owner = () => "owner",
        sources = createPackageSourceFeature({
          stateRoot: root,
          owner,
          runtimePool: runtime,
          ...storage.packageSources,
        });
      closers.push(sources.close);
      sources.start();
      const plugins = createPluginFeature({ stateRoot: root, owner, executor, persistence: storage.plugins });
      closers.push(plugins.close);
      const portable = createPortableTemplates({ stateRoot: root, owner, persistence: storage.portable });
      closers.push(portable.close);
      const reader = {
          project: <T>(actor: string, id: string, read: (source: CapturedPackageSource) => Promise<T>) =>
            sources.ingestion.project(actor, "templates", id, read),
        },
        consumer = {
          consume: <T>(
            actor: string,
            id: string,
            digest: string,
            read: (source: CapturedPackageSource) => Promise<T>,
          ) => sources.ingestion.consume(actor, "templates", id, digest, read),
        };
      const native = createNativeThemes({
        stateRoot: root,
        owner,
        sourceReader: reader,
        sourceConsumer: consumer,
        runtimePool: runtime,
        persistence: storage.native,
      });
      closers.push(native.close);
      const slides = createNativeSlidesTemplates({
        stateRoot: root,
        owner,
        sourceReader: reader,
        sourceConsumer: consumer,
        runtimePool: runtime,
        persistence: storage.nativeSlides,
      });
      closers.push(slides.close);
      const nativeSamples = createNativeSampleFeature({
        stateRoot: root,
        owner,
        themes: native.service,
        runtimePool: runtime,
        executor,
        ...storage.nativeSamples,
      });
      closers.push(nativeSamples.close);
      nativeSamples.start();
      const input = {
        protocol: 1 as const,
        engine: "hexo" as const,
        preset: "reader" as const,
        site: { title: "Saved site", locale: "en", url: "https://example.test", basePath: "/" },
        documents: [{ id: randomUUID(), path: "intro.md", title: "Intro", content: "Saved source" }],
        assets: [],
      };
      const builds = createSiteBuildFeature({
        stateRoot: root,
        owner,
        executor,
        ...storage.siteBuilds,
        sources: { authorize: async () => {}, capture: async () => ({ input, sources: [] }) },
        nativeThemes: nativeBuildThemes(native.service),
        inputBudget: runtime,
        authorizeInput: plugins.authorizeBuild,
      });
      closers.push(builds.close);
      const catalog = createTemplateCatalogFeature({
        owner,
        presentation: () => plugins.service.snapshot(),
        skills: () => ({ revision: 0, packages: [], nextCursor: null }),
        portable: () => portable.inspection.snapshot(),
        native: (actor) => native.service.snapshot(actor),
        nativeSlides: (actor) => slides.service.snapshot(actor),
      });
      let allowed = true;
      const publishing = createPublishingFeature(
        null,
        {
          authorize: async () => async () => {
            await Promise.resolve();
            if (!allowed) throw Error("revokedAuthorization");
          },
          current: async () => ({ revisionId: "revision" }),
          revision: async () => ({
            documentId: "doc",
            revisionId: "revision",
            title: "Saved article",
            locale: "en",
            content: "Frozen accepted content.",
            engine: "markdown",
          }),
        },
        {
          content: async () => {
            throw Error("No image fixture");
          },
        },
        plugins.templates,
        new PublicationVariantFiles(join(root, "variant-files")),
        storage.publishing,
      );
      const routes: Route[] = [
          ...sources.routes,
          ...plugins.routes,
          ...portable.routes,
          ...native.routes,
          ...slides.routes,
          ...nativeSamples.routes,
          ...builds.routes,
          ...catalog.routes,
          ...publishing.routes,
        ],
        dispatch = createRouter(routes);
      server = createServer((req, res) => {
        void dispatch({ req, res, url: new URL(req.url!, "http://" + req.headers.host) }).then(
          (handled) => {
            if (!handled) {
              res.writeHead(404);
              res.end();
            }
          },
          (error) => {
            res.writeHead(500);
            res.end(String(error));
          },
        );
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Fixture listener unavailable");
      const base = "http://127.0.0.1:" + address.port;
      const call = async (path: string, method = "GET", body?: unknown) => {
        const response = await fetch(base + path, {
          method,
          headers: { origin: base, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      };
      expect((await call("/api/document-packages")).body).toMatchObject({ revision: 0, packages: [] });
      const pack = exampleThemePackage(),
        review = await plugins.service.review(pack),
        approval = {
          digest: review.digest,
          expectedRevision: review.revision,
          permissions: review.permissions,
          selected: review.selected,
          reviewHash: review.reviewHash,
        };
      expect((await call("/api/document-packages/install", "POST", { package: pack, approval })).status).toBe(201);
      expect((await plugins.templates.list()).some((value) => value.id === "example.studio.paper")).toBe(true);
      expect((await plugins.themes.resolve("example.studio.journal@1.0.0", "hexo")).kind).toBe("installed");
      let draft = await plugins.library.save(exampleTemplateDefinition(), "owner");
      const preview = await plugins.library.preview(draft.id, "core");
      draft = await plugins.library.acceptBaseline(draft.id, draft.revision, "core", preview.actualDigest!, "owner");
      draft = await plugins.library.validate(draft.id, draft.revision, "owner");
      expect(draft.validation?.passed).toBe(true);
      const libraryReview = await plugins.service.review(draft.definition.package),
        released = await plugins.library.publish(
          draft.id,
          draft.revision,
          draft.digest,
          {
            digest: libraryReview.digest,
            expectedRevision: libraryReview.revision,
            permissions: libraryReview.permissions,
          },
          "owner",
        );
      expect((await plugins.library.release(released.id, released.version)).digest).toBe(draft.digest);
      const sample = await plugins.samples.start(
        { id: randomUUID(), source: { kind: "catalog", engine: "hexo", reference: "example.studio.journal@1.0.0" } },
        "owner",
      );
      await until(
        () => plugins.samples.detail(sample.id, "owner"),
        (job) => job.phase === "running",
      );
      executor.complete(sample.id);
      await until(
        () => plugins.samples.detail(sample.id, "owner"),
        (job) => job.phase === "completed",
      );
      expect((await call("/api/site-samples/detail?id=" + sample.id)).body.build.artifactAvailable).toBe(true);
      const upload = await PortableTemplateSource.read(fixtureBytes(await portableFixture()), "templates.json"),
        portableReview = await portable.installation.review(upload, ["example.article-outline@1.0.0"]),
        portableApproval = {
          operationId: randomUUID(),
          expectedRevision: portableReview.revision,
          reviewHash: portableReview.reviewHash,
          selected: portableReview.selected,
        };
      const installed = await portable.installation.install(upload, portableApproval, "owner");
      expect((await portable.installation.install(upload, portableApproval, "owner")).receipt).toEqual(
        installed.receipt,
      );
      expect((await call("/api/template-catalog?registry=portable")).status).toBe(200);
      const intake = async (captured: CapturedPackageSource) => {
        const origin = captured.descriptor.origin;
        if (origin.kind !== "zip-upload") throw Error("ZIP fixture required");
        const stage = await sources.ingestion.submit("owner", "templates", randomUUID(), {
          source: {
            kind: "zip-upload",
            name: origin.name,
            bytes: captured.descriptor.archiveBytes,
            sha256: origin.archiveSha256,
          },
          selected: captured.tree.files.map((file) => file.path),
        });
        const bytes = captured.readArchive()!;
        const response = await fetch(
          base + `/api/package-sources/upload?purpose=templates&id=${stage.id}&revision=${stage.revision}`,
          {
            method: "POST",
            headers: { origin: base, "content-type": "application/zip" },
            body: new Blob([new Uint8Array(bytes).buffer as ArrayBuffer]),
          },
        );
        expect(response.status).toBe(200);
        return until(
          () => sources.ingestion.read("owner", "templates", stage.id),
          (value) => value.state === "ready",
        );
      };
      const nativeSource = await nativeZipSource(),
        staged = await intake(nativeSource.source),
        nativeInput = { source: { id: staged.id, sha256: staged.digest, root: "theme" }, settings: nativeSettings() },
        nativeReview = await native.service.review("owner", nativeInput),
        nativeApproval = {
          operationId: randomUUID(),
          expectedRevision: nativeReview.revision,
          reviewHash: nativeReview.reviewHash,
          permissions: ["build:theme-code"],
          licenseAcknowledged: true,
        };
      const nativeInstalled = await native.service.install("owner", { ...nativeInput, approval: nativeApproval });
      expect((await native.service.install("owner", { ...nativeInput, approval: nativeApproval })).receipt).toEqual(
        nativeInstalled.receipt,
      );
      const nativeRef = {
        id: nativeInstalled.receipt.id,
        version: nativeInstalled.receipt.version,
        digest: nativeInstalled.receipt.digest,
      };
      executor.loseResponse = true;
      const nativeRun = await nativeSamples.service.start("owner", { id: randomUUID(), theme: nativeRef });
      await until(
        () => nativeSamples.service.detail("owner", nativeRun.id),
        (job) => job.phase === "running",
      );
      executor.complete(nativeRun.id);
      await until(
        () => nativeSamples.service.detail("owner", nativeRun.id),
        (job) => job.phase === "completed",
      );
      expect((await nativeSamples.service.start("owner", { id: nativeRun.id, theme: nativeRef })).id).toBe(
        nativeRun.id,
      );
      const projectRun = await builds.service.start(
        {
          id: randomUUID(),
          spaceId: randomUUID(),
          engine: "hexo",
          title: "Saved site",
          locale: "en",
          url: "https://example.test",
          basePath: "/",
          nativeTheme: nativeRef,
        },
        "owner",
      );
      await until(
        () => builds.service.detail(projectRun.id, "owner"),
        (job) => job.phase === "running",
      );
      executor.complete(projectRun.id);
      await until(
        () => builds.service.detail(projectRun.id, "owner"),
        (job) => job.phase === "completed",
      );
      expect((await stores.builds.resources.reservation(projectRun.id)).ready).toBe(true);
      const deck = await nativeSlidesFixture(),
        capturedDeck = await captureNativeSlidesBundle(deck.template),
        deckStage = await intake(capturedDeck),
        deckInput = {
          source: { id: deckStage.id, sha256: deckStage.digest, selection: { kind: "bundle", root: "" } },
          definition: null,
        },
        deckReview = await slides.service.review("owner", deckInput),
        deckApproval = {
          operationId: randomUUID(),
          expectedRevision: deckReview.revision,
          reviewHash: deckReview.reviewHash,
          licenseAcknowledged: true,
        };
      const deckInstalled = await slides.service.install("owner", { ...deckInput, approval: deckApproval });
      expect((await slides.service.snapshot("owner")).templates[0]!.digest).toBe(deckInstalled.receipt.digest);
      expect(
        (await catalog.catalog.list({ registry: "native-slides" }, "owner")).templates.some(
          (value) => value.reference.registry === "native-slides",
        ),
      ).toBe(true);
      const variant = await publishing.variants.prepare({
        documentId: "doc",
        revisionId: "revision",
        mode: "format",
        format: "html",
        templateId: "example.studio.paper",
        templateVersion: "1.0.0",
      });
      expect(variant.variant.templateId).toBe("example.studio.paper");
      allowed = false;
      await expect(publishing.variants.detail(variant.variant.id)).rejects.toThrow("revokedAuthorization");
      allowed = true;
      expect((await publishing.variants.detail(variant.variant.id)).digest).toBe(variant.digest);
      const all = await readdir(root, { recursive: true });
      expect(all.some((file) => file.endsWith(".sqlite"))).toBe(false);
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      for (const close of closers.reverse()) await close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  240000,
);

test.skipIf(!process.env.PANDA_FORCE_TEST_MYSQL_CONFIG_FILE)(
  "native draft images, immutable publication and owned template recovery survive reopening without intake tasks",
  async () => {
    const database = await isolatedMySQLDatabase("draft"),
      root = await mkdtemp(join(tmpdir(), "mysql-extension-recovery-")),
      closers: Array<() => Promise<unknown> | void> = [];
    try {
      for (const module of [mysqlTemplatesModule, mysqlPackageSourcesModule])
        for (const migration of module.migrations.mysql!)
          for (const step of migration.steps) await database.sql.unsafe(step.sql);
      const stores = createMySQLExtensionStores(database.sql),
        storage = mySQLExtensionPersistence(stores),
        runtime = new SourceRuntime(),
        owner = () => "owner",
        sources = createPackageSourceStages({
          root: join(root, "package-sources"),
          runtimePool: runtime,
          ...storage.packageSources,
        });
      closers.push(sources.close);
      const intake = async (captured: CapturedPackageSource) => {
        const origin = captured.descriptor.origin;
        if (origin.kind !== "zip-upload") throw Error("Expected fixture archive");
        const stage = await sources.ingestion.submit("owner", "templates", randomUUID(), {
          source: {
            kind: "zip-upload",
            name: origin.name,
            bytes: captured.descriptor.archiveBytes,
            sha256: origin.archiveSha256,
          },
          selected: captured.tree.files.map((file) => file.path),
        });
        return sources.templates.execute("owner", stage.id, stage.revision, async () => captured);
      };
      let portable = createPortableTemplates({ stateRoot: root, owner, persistence: storage.portable });
      closers.push(() => portable.close());
      const upload = await PortableTemplateSource.read(fixtureBytes(await portableFixture()), "fixture.json"),
        review = await portable.installation.review(upload, ["example.article-outline@1.0.0"]);
      await portable.installation.install(
        upload,
        {
          operationId: randomUUID(),
          expectedRevision: review.revision,
          reviewHash: review.reviewHash,
          selected: review.selected,
        },
        "owner",
      );
      const original = (await portable.inspection.snapshot()).templates[0]!,
        command = {
          operationId: randomUUID(),
          id: randomUUID(),
          expectedRevision: 0,
          reference: {
            registry: "portable",
            kind: "template",
            id: original.id,
            version: original.version,
            digest: original.digest,
          },
        },
        fork = (await portable.drafts.execute("owner", "fork", command)).current!;
      expect(fork.definition.version).toBe("1.0.1");
      const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#345678" } })
          .png()
          .toBuffer(),
        image = await portable.images.upload("owner", command.id, bytes);
      expect(await portable.images.upload("owner", command.id, bytes)).toEqual(image);
      await expect(portable.images.content("another-owner", command.id, image.id)).rejects.toThrow("draftNotFound");
      const definition = structuredClone(fork.definition);
      definition.images = [image];
      definition.contentSlots = [];
      definition.body.document.content = [
        { type: "paragraph", content: [{ type: "text", text: "Owned reusable illustration" }] },
        {
          type: "image",
          attrs: { src: "/api/document-assets/content?id=" + image.id, alt: "Reusable fixture", width: 8, height: 6 },
        },
      ];
      const save = { operationId: randomUUID(), id: command.id, expectedRevision: 1, definition },
        saved = (await portable.drafts.execute("owner", "save", save)).current!,
        draft = saved.draft,
        publishReview = await portable.drafts.review("owner", draft.id, draft.revision, draft.digest),
        approval = {
          operationId: randomUUID(),
          expectedRevision: publishReview.revision,
          reviewHash: publishReview.reviewHash,
          selected: publishReview.selected,
        },
        published = await portable.drafts.publish("owner", draft.id, draft.revision, draft.digest, approval);
      portable.close();
      portable = createPortableTemplates({
        stateRoot: root,
        owner,
        persistence: mySQLExtensionPersistence(createMySQLExtensionStores(database.sql)).portable,
      });
      expect((await portable.drafts.detail("owner", draft.id)).definition.images).toEqual([image]);
      expect((await portable.drafts.execute("owner", "save", save)).acknowledgement).toEqual({
        operationId: save.operationId,
        id: draft.id,
        revision: draft.revision,
        digest: draft.digest,
        removed: false,
      });
      expect(
        (await portable.drafts.publish("owner", draft.id, draft.revision, draft.digest, approval)).receipt,
      ).toEqual(published.receipt);
      const materialized = await portable.documents
        .command({
          template: { id: draft.manifest.id, version: draft.manifest.version, digest: draft.digest },
          values: { title: "Saved title", audience: "Fixture reader" },
        })
        .prepare();
      expect(materialized.images[0]!.bytes).toEqual(new Uint8Array(bytes));
      expect((await portable.inspection.detail(original.id, original.version, original.digest)).template.digest).toBe(
        original.digest,
      );
      const reader = {
          project: <T>(actor: string, id: string, read: (source: CapturedPackageSource) => Promise<T>) =>
            sources.ingestion.project(actor, "templates", id, read),
        },
        consumer = {
          consume: <T>(
            actor: string,
            id: string,
            digest: string,
            read: (source: CapturedPackageSource) => Promise<T>,
          ) => sources.ingestion.consume(actor, "templates", id, digest, read),
        };
      let failCommit = true;
      const interrupted: MetadataStore<NativeThemeRegistry> = new Proxy(stores.nativeThemes, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "commit")
            return async (...args: Parameters<NativeThemeRegistry["commit"]>) => {
              if (failCommit) {
                failCommit = false;
                throw new NativeThemeError("busy");
              }
              return target.commit(...args);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let native = createNativeThemes({
        stateRoot: root,
        owner,
        sourceReader: reader,
        sourceConsumer: consumer,
        runtimePool: runtime,
        persistence: { ...storage.native, registry: interrupted },
      });
      closers.push(() => native.close());
      const theme = await nativeZipSource(),
        stage = await intake(theme.source),
        themeInput = { source: { id: stage.id, sha256: stage.digest, root: "theme" }, settings: nativeSettings() },
        themeReview = await native.service.review("owner", themeInput),
        themeCommand = {
          ...themeInput,
          approval: {
            operationId: randomUUID(),
            expectedRevision: themeReview.revision,
            reviewHash: themeReview.reviewHash,
            permissions: ["build:theme-code"],
            licenseAcknowledged: true,
          },
        };
      await expect(native.service.install("owner", themeCommand)).rejects.toThrow("busy");
      await native.close();
      await sources.ingestion.remove("owner", "templates", stage.id, stage.revision);
      const reopened = mySQLExtensionPersistence(createMySQLExtensionStores(database.sql)),
        delayed: MetadataStore<NativeThemeRegistry> = new Proxy(reopened.native.registry, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (key === "commit")
              return async (...args: Parameters<NativeThemeRegistry["commit"]>) => {
                await Bun.sleep(20);
                return target.commit(...args);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      native = createNativeThemes({
        stateRoot: root,
        owner,
        sourceReader: reader,
        sourceConsumer: consumer,
        runtimePool: runtime,
        persistence: { ...reopened.native, registry: delayed },
      });
      const installed = await native.service.install("owner", themeCommand),
        reference = { id: "example.native", version: "1.0.0", digest: installed.receipt.digest };
      expect((await native.service.install("owner", themeCommand)).receipt).toEqual(installed.receipt);
      expect(
        await native.service.source("owner", reference, async (value) =>
          value.source.tree.read("theme/source/logo.bin"),
        ),
      ).toEqual(new Uint8Array([0, 10, 255]));
      await expect(native.service.source("another-owner", reference, async () => {})).rejects.toThrow("notFound");
      let slides = createNativeSlidesTemplates({
        stateRoot: root,
        owner,
        sourceReader: reader,
        sourceConsumer: consumer,
        runtimePool: runtime,
        persistence: storage.nativeSlides,
      });
      closers.push(() => slides.close());
      const deck = await nativeSlidesFixture(),
        captured = await captureNativeSlidesBundle(deck.template),
        deckStage = await intake(captured),
        deckInput = {
          source: { id: deckStage.id, sha256: deckStage.digest, selection: { kind: "bundle", root: "" } },
          definition: null,
        },
        deckReview = await slides.service.review("owner", deckInput),
        deckCommand = {
          ...deckInput,
          approval: {
            operationId: randomUUID(),
            expectedRevision: deckReview.revision,
            reviewHash: deckReview.reviewHash,
            licenseAcknowledged: true,
          },
        },
        deckResult = await slides.service.install("owner", deckCommand);
      await slides.close();
      await sources.ingestion.remove("owner", "templates", deckStage.id, deckStage.revision);
      slides = createNativeSlidesTemplates({
        stateRoot: root,
        owner,
        sourceReader: reader,
        sourceConsumer: consumer,
        runtimePool: runtime,
        persistence: mySQLExtensionPersistence(createMySQLExtensionStores(database.sql)).nativeSlides,
      });
      expect((await slides.service.install("owner", deckCommand)).receipt).toEqual(deckResult.receipt);
      expect(
        await slides.service.with(
          "owner",
          { id: deck.settings.id, version: deck.settings.version, digest: deckResult.receipt.digest },
          async (template) => template.original(),
        ),
      ).toEqual(deck.original);
      expect(runtime.snapshot()).toEqual({ active: 0, bytes: 0 });
      expect((await readdir(root, { recursive: true })).some((path) => path.endsWith(".sqlite"))).toBe(false);
    } finally {
      for (const close of closers.reverse()) await close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  240000,
);
