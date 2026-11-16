import { resourceBuildFixture } from "./resource-build.js";
import { freezeTrustedBuildTheme } from "../../src/shared/builds/trusted-theme.js";
import { siteSampleInput, sampleCapture } from "../../src/server/plugins/integration/site-sample-input.js";
import { SqliteSiteSamples } from "../../src/server/plugins/storage/site-samples.js";
import { sourceStageRequest } from "../../src/shared/packages/stages/input.js";
import { nativeSlidesFixture } from "./native-slides.js";
import { captureNativeSlidesBundle } from "../../src/server/slides/templates/bundle.js";
import { NativeSlidesDescriptor } from "../../src/server/slides/templates/descriptor.js";
import { openNativeSlidesDatabase, SqliteNativeSlides } from "../../src/server/slides/storage/registry.js";
import { migrateNativeSlidesSnapshot } from "../../src/server/slides/storage/migrate.js";
import { PublicationVariantFiles } from "../../src/server/publishing/variant-files.js";
import type { SQL } from "bun";
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { exampleThemePackage } from "./theme-package.mjs";
import { exampleTemplateDefinition } from "./template-definition.mjs";
import { portableFixture, fixtureBytes } from "./portable-templates.js";
import { nativeSettings, nativeZipSource } from "./native-theme.js";
import { verifyPluginPackage } from "../../src/shared/plugins/package.js";
import { pluginExports } from "../../src/shared/plugins/exports.js";
import { verifyTemplateDefinition } from "../../src/shared/plugins/library-validation.js";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { SqlitePluginRegistry } from "../../src/server/plugins/storage/repository.js";
import { SqliteTemplateLibrary } from "../../src/server/plugins/storage/library.js";
import { migratePluginsSnapshot } from "../../src/server/plugins/storage/migrate.js";
import { openPortableTemplateDatabase } from "../../src/server/templates/storage/database.js";
import { SqlitePortableTemplates } from "../../src/server/templates/storage/registry.js";
import { SqliteTemplateDrafts } from "../../src/server/templates/storage/drafts.js";
import { SqliteTemplateImages } from "../../src/server/templates/storage/images.js";
import { migratePortableTemplatesSnapshot } from "../../src/server/templates/storage/migrate.js";
import { PortableTemplateSource } from "../../src/server/templates/portable/source.js";
import { openSourceStageDatabase } from "../../src/server/packages/staging/database.js";
import { SqliteSourceStages } from "../../src/server/packages/staging/repository.js";
import {
  migratePackageSourcesSnapshot,
  migrateNativeThemeSourcesSnapshot,
  migrateNativeSlidesSourcesSnapshot,
} from "../../src/server/packages/staging/migrate.js";
import { sourceLimits } from "../../src/shared/packages/sources/contracts.js";
import { NativeSiteTheme } from "../../src/shared/templates/native/package.js";
import { openNativeThemeDatabase } from "../../src/server/templates/storage/native-database.js";
import { SqliteNativeThemes } from "../../src/server/templates/storage/native-registry.js";
import { migrateNativeThemesSnapshot } from "../../src/server/templates/storage/native-migrate.js";
import { SiteBuildRepository } from "../../src/server/builds/repository.js";
import { migrateSiteBuildsSnapshot } from "../../src/server/builds/migrate.js";
import { openNativeSampleDatabase } from "../../src/server/builds/native/database.js";
import { SqliteNativeSamples } from "../../src/server/builds/native/repository.js";
import { migrateNativeSamplesSnapshot } from "../../src/server/builds/native/migrate.js";
import type { NativeSampleBuild } from "../../src/shared/builds/native-samples.js";
import { VariantRepository } from "../../src/server/publishing/variant-repository.js";
import { VariantService } from "../../src/server/publishing/variant-service.js";
import { builtinFormats } from "../../src/server/publishing/adapters/builtin-formats.js";
import { migratePublishingSnapshot } from "../../src/server/publishing/migrate.js";
import { createMySQLExtensionStores } from "../../src/server/database/extension-stores.js";

/** All bodies and snapshots are generated below a temporary directory. No runtime or account state is opened. */
export async function verifyMySQLExtensionParity(sql: SQL) {
  const root = await mkdtemp(join(tmpdir(), "mysql-extension-parity-")),
    dbs: Database[] = [];
  const open = (db: Database) => {
    dbs.push(db);
    return db;
  };
  const freeze = (db: Database) => {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    dbs.splice(dbs.indexOf(db), 1);
  };
  const stores = createMySQLExtensionStores(sql);
  try {
    const pluginPath = join(root, "plugins.sqlite"),
      plugins = open(openPluginDatabase(pluginPath)),
      sqlitePlugins = new SqlitePluginRegistry(plugins),
      pack = await verifyPluginPackage(exampleThemePackage()),
      mutation = { actor: "owner", now: 1, expectedRevision: 0 };
    sqlitePlugins.install(
      pack.package.manifest,
      pack.digest,
      pluginExports(pack.package.manifest),
      pack.package.manifest.permissions,
      mutation,
    );
    const checked = await verifyTemplateDefinition(exampleTemplateDefinition()),
      library = new SqliteTemplateLibrary(plugins),
      draftId = randomUUID();
    const draft = library.save(checked.definition, checked.digest, checked.packageDigest, draftId, null, "owner", 2),
      expectedPlugins = sqlitePlugins.snapshot(),
      expectedAudit = sqlitePlugins.audit(),
      expectedLibrary = library.snapshot();
    const sampleTheme = await freezeTrustedBuildTheme(pack.package, "journal"),
      sampleInput = siteSampleInput(sampleTheme, {
        id: "core",
        title: "Fixture",
        locale: "en",
        content: "Sample content",
      }),
      sampleRequest = {
        id: randomUUID(),
        source: { kind: "catalog" as const, engine: "hexo" as const, reference: "example.studio.journal@1.0.0" },
      },
      sampleCaptureValue = await sampleCapture(sampleInput, { source: sampleRequest.source, fixtureId: "core" }),
      sqliteSiteSamples = new SqliteSiteSamples(plugins, () => 3),
      siteSample = sqliteSiteSamples.create(sampleRequest, sampleCaptureValue, "owner");
    sqliteSiteSamples.saveLogs(siteSample.id, "sample logs");
    freeze(plugins);
    await migratePluginsSnapshot({ sql, snapshotPath: pluginPath, migrationId: "extension-parity" });
    await migratePluginsSnapshot({ sql, snapshotPath: pluginPath, migrationId: "extension-parity" });
    expect(await stores.plugins.snapshot()).toEqual(expectedPlugins);
    expect(await stores.plugins.audit()).toEqual(expectedAudit);
    expect(await stores.templateLibrary.snapshot()).toEqual(expectedLibrary);
    expect(await stores.templateLibrary.get(draftId)).toEqual(draft);
    expect(await stores.siteSamples.get(siteSample.id)).toEqual(siteSample);
    expect(await stores.siteSamples.logs(siteSample.id)).toBe("sample logs");
    expect(await stores.siteSamples.create(sampleRequest, sampleCaptureValue, "owner")).toEqual(siteSample);
    await expect(stores.siteSamples.existing(sampleRequest, "other")).rejects.toThrow("sampleNotFound");
    await expect(
      stores.plugins.install(
        pack.package.manifest,
        "f".repeat(64),
        pluginExports(pack.package.manifest),
        pack.package.manifest.permissions,
        { ...mutation, expectedRevision: 1 },
      ),
    ).rejects.toThrow("immutableVersion");
    const races = await Promise.allSettled([
      stores.plugins.setEnabled(pack.package.manifest.id, pack.package.manifest.version, false, {
        ...mutation,
        expectedRevision: 1,
      }),
      stores.plugins.setEnabled(pack.package.manifest.id, pack.package.manifest.version, false, {
        ...mutation,
        expectedRevision: 1,
      }),
    ]);
    expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await stores.plugins.get(pack.package.manifest.id, pack.package.manifest.version)).exports.every(
        (e) => !e.active,
      ),
    ).toBe(true);
    // A publisher callback uses the same native connection; a rejected receipt rolls back the install too.
    const report = {
      definitionDigest: checked.digest,
      passed: true,
      results: [],
      runnerVersion: "fixture",
      checkedAt: 3,
      missingCoverage: [],
    };
    const validated = await stores.templateLibrary.validate(draftId, 1, report as never, "owner", 3);
    const registryRevision = (await stores.plugins.snapshot()).revision;
    await expect(
      stores.templateLibrary.publish(draftId, validated.revision, checked.digest, "owner", 4, async () => {
        await stores.plugins.install(
          checked.definition.package.manifest,
          checked.packageDigest,
          pluginExports(checked.definition.package.manifest),
          checked.definition.package.manifest.permissions,
          { actor: "owner", now: 4, expectedRevision: registryRevision },
        );
        throw Error("simulatedReceiptLoss");
      }),
    ).rejects.toThrow("simulatedReceiptLoss");
    expect((await stores.plugins.snapshot()).revision).toBe(registryRevision);
    await expect(stores.plugins.get(checked.definition.package.manifest.id, "1.0.0")).rejects.toThrow(
      "packageNotInstalled",
    );
    const release = await stores.templateLibrary.publish(draftId, validated.revision, checked.digest, "owner", 5, () =>
      stores.plugins.install(
        checked.definition.package.manifest,
        checked.packageDigest,
        pluginExports(checked.definition.package.manifest),
        checked.definition.package.manifest.permissions,
        { actor: "owner", now: 5, expectedRevision: registryRevision },
      ),
    );
    expect(release.packageDigest).toBe(checked.packageDigest);
    expect((await stores.templateLibrary.snapshot()).releases).toHaveLength(1);

    const portablePath = join(root, "portable.sqlite"),
      portableDB = open(openPortableTemplateDatabase(portablePath)),
      portable = new SqlitePortableTemplates(portableDB),
      drafts = new SqliteTemplateDrafts(portableDB),
      imageStore = new SqliteTemplateImages(portableDB),
      upload = await PortableTemplateSource.read(fixtureBytes(await portableFixture()), "templates.json"),
      template = upload.library.templates[0]!,
      operationId = randomUUID(),
      installed = portable.install([template], upload.origin, {
        actor: "owner",
        operationId,
        request: "portable-review",
        expectedRevision: 0,
        now: 1,
      }),
      draftCommand = {
        actor: "owner",
        id: randomUUID(),
        operationId: randomUUID(),
        request: "draft-review",
        expectedRevision: 0,
        now: 2,
      },
      draftReceipt = drafts.save(template, draftCommand),
      image = {
        id: randomUUID(),
        path: "images/cover.png",
        sha256: "a".repeat(64),
        bytes: 10,
        mediaType: "image/png" as const,
        width: 1,
        height: 1,
      };
    imageStore.bind("owner", draftCommand.id, image);
    const portableSnapshot = portable.snapshot();
    freeze(portableDB);
    await migratePortableTemplatesSnapshot({ sql, snapshotPath: portablePath, migrationId: "extension-parity" });
    expect(await stores.portableTemplates.snapshot()).toEqual(portableSnapshot);
    expect(await stores.portableTemplates.replay("owner", operationId, "portable-review")).toEqual(installed);
    expect(await stores.portableDrafts.replay("owner", draftCommand.operationId, "draft-review")).toEqual(draftReceipt);
    expect(await stores.portableImages.get("owner", draftCommand.id, image.id)).toEqual(image);
    await expect(stores.portableImages.get("other", draftCommand.id, image.id)).rejects.toThrow("draftNotFound");
    const disabled = await stores.portableTemplates.state(
      template.manifest.id,
      template.manifest.version,
      "disable",
      "owner",
      portableSnapshot.revision,
      3,
    );
    expect(disabled.enabled).toBe(false);
    expect(await stores.portableTemplates.replay("owner", operationId, "portable-review")).toEqual(installed);
    const newCommand = { ...draftCommand, operationId: randomUUID(), expectedRevision: 1, now: 4 };
    expect((await stores.portableDrafts.save(template, newCommand)).revision).toBe(2);

    const stagePath = join(root, "stages.sqlite"),
      stageDB = open(openSourceStageDatabase(stagePath)),
      stages = new SqliteSourceStages(stageDB),
      request = sourceStageRequest({
        source: {
          kind: "github",
          repository: "https://github.com/example/repository",
          repositoryId: 1,
          ref: "main",
          root: "",
        },
        selected: ["README.md"],
      }),
      stageData = {
        actor: "owner",
        id: randomUUID(),
        operationId: randomUUID(),
        purpose: "templates" as const,
        request,
        limits: sourceLimits(),
        fingerprint: createHash("sha256")
          .update(JSON.stringify({ purpose: "templates", request }))
          .digest("hex"),
        reservedBytes: 100,
        now: 1,
      },
      stage = stages.create(stageData, () => {}),
      claim = stages.claim("owner", stage.id, 1, 2, 10);
    freeze(stageDB);
    await migratePackageSourcesSnapshot({ sql, snapshotPath: stagePath, migrationId: "extension-parity" });
    await migrateNativeThemeSourcesSnapshot({ sql, snapshotPath: stagePath, migrationId: "extension-parity" });
    await migrateNativeSlidesSourcesSnapshot({ sql, snapshotPath: stagePath, migrationId: "extension-parity" });
    const mainStages = stores.sourceStages("package"),
      themeStages = stores.sourceStages("native_theme"),
      slideStages = stores.sourceStages("native_slides");
    expect(await mainStages.read("owner", stage.id)).toEqual(claim.stage);
    await expect(mainStages.read("other", stage.id)).rejects.toThrow("stageNotFound");
    await expect(mainStages.bind("owner", claim, "a".repeat(64), 13)).rejects.toThrow("stageConflict");
    const recovered = await mainStages.recovery("owner", stage.id, claim.stage.revision, 13);
    expect(recovered.state).toBe("failed");
    expect((await themeStages.read("owner", stage.id)).state).toBe("acquiring");
    expect((await themeStages.candidates(13)).map((v) => v.id)).toContain(stage.id);
    await expect(
      stores
        .sourceStages("package", { ownerBytes: 1000, globalBytes: 1000, ownerItems: 1, globalItems: 1 })
        .create({ ...stageData, id: randomUUID(), operationId: randomUUID() }, () => {}),
    ).rejects.toThrow("stageCapacity");
    expect((await slideStages.read("owner", stage.id)).state).toBe("acquiring");
    expect((await mainStages.events("owner", stage.id)).map((e) => e.revision)).toEqual([1, 2, 3]);
    expect(await mainStages.replay("owner", stageData.operationId, stageData.fingerprint)).toEqual(recovered);
    const cancelledStage = await mainStages.cancel("owner", stage.id, recovered.revision, 14);
    const removingStage = await mainStages.removing("owner", stage.id, cancelledStage.revision, 15);
    expect((await mainStages.removed("owner", stage.id, removingStage.revision, 16)).reservedBytes).toBe(0);
    const freshStage = await mainStages.create(
      { ...stageData, id: randomUUID(), operationId: randomUUID(), now: 17 },
      () => {},
    );
    const claimRaces = await Promise.allSettled([
      mainStages.claim("owner", freshStage.id, freshStage.revision, 18, 100),
      mainStages.claim("owner", freshStage.id, freshStage.revision, 18, 100),
    ]);
    expect(claimRaces.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await mainStages.events("owner", freshStage.id)).map((event) => event.revision)).toEqual([1, 2]);

    const nativePath = join(root, "native.sqlite"),
      nativeDB = open(openNativeThemeDatabase(nativePath)),
      native = new SqliteNativeThemes(nativeDB, () => 10),
      source = await nativeZipSource(),
      value = await NativeSiteTheme.create(source.source, "theme", nativeSettings()),
      nativeId = randomUUID();
    native.reserve(
      "owner",
      "native-review",
      value.descriptor,
      {
        operationId: nativeId,
        expectedRevision: 0,
        reviewHash: "d".repeat(64),
        permissions: ["build:theme-code"],
        licenseAcknowledged: true,
      },
      "b".repeat(64),
    );
    const receipt = native.commit("owner", nativeId, { id: randomUUID(), digest: value.source.digest }),
      nativeSnapshot = native.snapshot("owner");
    freeze(nativeDB);
    await migrateNativeThemesSnapshot({ sql, snapshotPath: nativePath, migrationId: "extension-parity" });
    expect((await stores.nativeThemes.snapshot("owner")).themes).toEqual(nativeSnapshot.themes);
    expect((await stores.nativeThemes.operation("owner", nativeId))?.receipt).toEqual(receipt);
    expect((await stores.nativeSlides.snapshot("owner")).versions).toEqual([]);
    expect(await stores.nativeThemes.snapshot("other")).toMatchObject({ revision: 0, themes: [] });
    const slidesPath = join(root, "slides.sqlite"),
      slidesDB = open(openNativeSlidesDatabase(slidesPath)),
      slides = new SqliteNativeSlides(slidesDB, () => 10),
      slidesValue = await nativeSlidesFixture(),
      capturedSlides = await captureNativeSlidesBundle(slidesValue.template),
      slidesDescriptor = await NativeSlidesDescriptor.create(slidesValue.template, capturedSlides, {
        digest: capturedSlides.digest,
        origin: capturedSlides.descriptor.origin,
        selection: { kind: "bundle", root: "" },
      }),
      slidesOperation = randomUUID();
    slides.reserve(
      "owner",
      "slides-review",
      slidesDescriptor,
      { operationId: slidesOperation, expectedRevision: 0 },
      "c".repeat(64),
    );
    const slidesReceipt = slides.commit("owner", slidesOperation, { id: randomUUID(), digest: capturedSlides.digest }),
      slidesSnapshot = slides.snapshot("owner");
    freeze(slidesDB);
    await migrateNativeSlidesSnapshot({ sql, snapshotPath: slidesPath, migrationId: "extension-parity" });
    expect(await stores.nativeSlides.snapshot("owner")).toEqual(slidesSnapshot);
    expect((await stores.nativeSlides.operation("owner", slidesOperation))?.receipt).toEqual(slidesReceipt);
    const ref = await stores.nativeThemes.source("owner", value.descriptor.data.settings.id, "1.0.0");
    expect(ref.digest).toBe(value.source.digest);
    expect(await stores.nativeThemes.commit("owner", nativeId, ref)).toEqual(receipt);
    await expect(
      stores.nativeThemes.reserve(
        "owner",
        "altered-review",
        value.descriptor,
        {
          operationId: nativeId,
          expectedRevision: 0,
          reviewHash: "d".repeat(64),
          permissions: ["build:theme-code"],
          licenseAcknowledged: true,
        },
        "b".repeat(64),
      ),
    ).rejects.toThrow("conflict");
    const retained = await stores.nativeThemes.reserve(
      "owner",
      "retained-review",
      value.descriptor,
      {
        operationId: randomUUID(),
        expectedRevision: nativeSnapshot.revision,
        reviewHash: "d".repeat(64),
        permissions: ["build:theme-code"],
        licenseAcknowledged: true,
      },
      "b".repeat(64),
    );
    expect(retained.receipt?.status).toBe("retained");
    expect(
      (
        await stores.nativeThemes.state(
          "owner",
          value.descriptor.data.settings.id,
          "1.0.0",
          value.digest,
          "disable",
          nativeSnapshot.revision,
        )
      ).enabled,
    ).toBe(false);

    const sitePath = join(root, "builds.sqlite"),
      siteDB = open(new Database(sitePath)),
      builds = new SiteBuildRepository(siteDB),
      buildInput = {
        protocol: 1 as const,
        engine: "hexo" as const,
        preset: "reader" as const,
        site: { title: "Fixture", locale: "en", url: "https://example.test", basePath: "/" },
        documents: [{ id: "doc", path: "doc.md", title: "Doc", content: "Saved content" }],
        assets: [],
      },
      buildRequest = {
        id: randomUUID(),
        spaceId: "space",
        engine: "hexo" as const,
        title: "Fixture",
        locale: "en",
        url: "https://example.test",
        basePath: "/",
      },
      build = builds.create(buildRequest, buildInput, []);
    builds.saveLogs(build.id, "isolated build logs");
    freeze(siteDB);
    await migrateSiteBuildsSnapshot({ sql, snapshotPath: sitePath, migrationId: "extension-parity" });
    expect(await stores.builds.get(build.id)).toEqual(build);
    expect(await stores.builds.input(build.id)).toEqual(buildInput);
    expect(await stores.builds.logs(build.id)).toBe("isolated build logs");
    expect(await stores.builds.create(buildRequest, buildInput, [])).toEqual(build);
    expect(
      (await stores.builds.update(build.id, { phase: "completed", artifactAvailable: true })).artifactAvailable,
    ).toBe(true);
    await expect(stores.builds.update(build.id, { phase: "running" })).rejects.toThrow("executorConflict");
    const resource = await resourceBuildFixture(),
      resourceRequest = {
        ...buildRequest,
        id: randomUUID(),
        nativeTheme: { id: resource.theme.id, version: resource.theme.version, digest: "d".repeat(64) },
      },
      resourceReservation = await stores.builds.resources.reserve("owner", resourceRequest, resource.request, []);
    expect(resourceReservation.created).toBe(true);
    expect(resourceReservation.value.ready).toBe(false);
    expect((await stores.builds.resources.pending()).map((v) => v.job.id)).toContain(resourceRequest.id);
    await expect(stores.builds.existing(resourceRequest, "other")).rejects.toThrow("notFound");
    expect(await stores.builds.resources.identity(resourceRequest.id)).toEqual({
      actor: "owner",
      theme: resourceRequest.nativeTheme,
    });
    await expect(stores.builds.resources.accept(resourceRequest.id, "f".repeat(64), 32)).rejects.toThrow(
      "snapshotUnavailable",
    );
    await stores.builds.resources.accept(resourceRequest.id, resource.request.digest, 32);
    expect((await stores.builds.active()).map((v) => v.id)).toContain(resourceRequest.id);
    await stores.builds.update(resourceRequest.id, { phase: "completed", artifactAvailable: true });
    await stores.builds.resources.released(resourceRequest.id);
    expect((await stores.builds.resources.reservation(resourceRequest.id)).reservedBytes).toBe(0);

    const samplePath = join(root, "samples.sqlite"),
      sampleDB = open(openNativeSampleDatabase(samplePath)),
      samples = new SqliteNativeSamples(sampleDB, () => 20),
      sample = {
        ...build,
        id: randomUUID(),
        key: "native-sample",
        theme: { id: "example.native", version: "1.0.0", digest: value.digest },
        runnerVersion: "1",
        engineVersion: "8",
        phase: "queued",
      } as NativeSampleBuild,
      reserved = samples.reserve("owner", "sample-review", sample);
    freeze(sampleDB);
    await migrateNativeSamplesSnapshot({ sql, snapshotPath: samplePath, migrationId: "extension-parity" });
    expect(await stores.nativeSamples.reservation(sample.id)).toEqual(reserved.value);
    await expect(stores.nativeSamples.existing("other", sample.id, "sample-review")).rejects.toThrow("notFound");
    expect((await stores.nativeSamples.pending()).map((v) => v.job.id)).toContain(sample.id);
    await stores.nativeSamples.accept(sample.id, sample.inputHash, 32);
    expect((await stores.nativeSamples.active()).map((v) => v.id)).toContain(sample.id);
    await stores.nativeSamples.update(sample.id, { phase: "completed", artifactAvailable: true });
    await stores.nativeSamples.archive(sample.id);
    await stores.nativeSamples.released(sample.id);
    await expect(stores.nativeSamples.owner(sample.id)).rejects.toThrow("notFound");
    expect((await stores.nativeSamples.reservation(sample.id)).reservedBytes).toBe(0);

    const publicationPath = join(root, "publishing.sqlite"),
      publicationDB = open(new Database(publicationPath)),
      repo = new VariantRepository(publicationDB),
      sources = {
        authorize: () => () => {},
        current: () => ({ revisionId: "revision" }),
        revision: () => ({
          documentId: "doc",
          revisionId: "revision",
          title: "Article",
          locale: "en",
          engine: "markdown" as const,
          content: "Saved article.",
        }),
      },
      variants = new VariantService(repo, sources, builtinFormats()),
      prepared = await variants.prepare({
        documentId: "doc",
        revisionId: "revision",
        mode: "format",
        format: "x-post",
        templateId: "technical",
      });
    const files = new PublicationVariantFiles(join(root, "variant-files")),
      fileSources = {
        authorize: () => () => {},
        current: () => ({ revisionId: "file-revision" }),
        revision: () => ({
          documentId: "file-doc",
          revisionId: "file-revision",
          projectId: "project",
          commit: "a".repeat(40),
          sourceHash: "b".repeat(64),
          title: "Saved file",
          locale: "en",
          engine: "markdown" as const,
          content: "Frozen source file.",
        }),
      },
      fileVariants = new VariantService(repo, fileSources, builtinFormats(), undefined, files),
      filePrepared = await fileVariants.prepare({
        documentId: "file-doc",
        revisionId: "file-revision",
        projectId: "project",
        mode: "format",
        format: "html",
        templateId: "technical",
      });
    const reviewed = await variants.review(
      prepared.variant.id,
      { digest: prepared.digest, acceptedIssues: prepared.variant.issues.map((i) => `${i.blockId}:${i.code}`) },
      "owner",
    );
    freeze(publicationDB);
    await migratePublishingSnapshot({ sql, snapshotPath: publicationPath, migrationId: "extension-parity" });
    const mysqlVariants = new VariantService(stores.publishing, sources, builtinFormats());
    expect(await mysqlVariants.detail(prepared.variant.id)).toEqual(reviewed);
    const mysqlFiles = new VariantService(stores.publishing, fileSources, builtinFormats(), undefined, files);
    expect(await mysqlFiles.detail(filePrepared.variant.id)).toEqual(filePrepared);
    expect((await stores.publishing.files.reference(filePrepared.variant.id))?.source.commit).toBe("a".repeat(40));
    expect((await mysqlFiles.list("file-doc", "project")).map((v) => v.id)).toContain(filePrepared.variant.id);
    const newVariant = await mysqlVariants.prepare({
      documentId: "doc",
      revisionId: "revision",
      mode: "format",
      format: "x-article",
      templateId: "technical",
    });
    expect(newVariant.variant.format).toBe("x-article");
    expect((await mysqlVariants.list("doc")).map((v) => v.format)).toContain("x-post");
    await expect(
      stores.publishing.review(prepared.variant.id, reviewed.review!, () => {
        throw Error("revokedAuthorization");
      }),
    ).rejects.toThrow("revokedAuthorization");
    expect((await mysqlVariants.detail(prepared.variant.id)).review).toEqual(reviewed.review);
    await expect(
      stores.publishing.review(prepared.variant.id, {
        digest: "f".repeat(64),
        reviewer: "owner",
        reviewedAt: 1,
        acceptedIssues: [],
      }),
    ).rejects.toThrow("staleVariant");
  } finally {
    for (const db of dbs) db.close();
    await rm(root, { recursive: true, force: true });
  }
}
