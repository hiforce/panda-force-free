import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openPluginDatabase } from "../../src/server/plugins/storage/database.js";
import { SqlitePluginRegistry } from "../../src/server/plugins/storage/repository.js";
import { FilePluginBundles } from "../../src/server/plugins/storage/bundles.js";
import { SqliteTemplateLibrary } from "../../src/server/plugins/storage/library.js";
import { SqliteSiteSamples } from "../../src/server/plugins/storage/site-samples.js";
import { PluginRegistryService } from "../../src/server/plugins/service.js";
import { TemplateLibraryService } from "../../src/server/plugins/library-service.js";
import { SiteSampleService } from "../../src/server/plugins/site-sample-service.js";
import { installedPresentation } from "../../src/server/plugins/integration/presentation.js";
import { siteSampleSources } from "../../src/server/plugins/integration/site-sample-sources.js";
import { siteFixturePreview } from "../../src/server/plugins/integration/site-fixture-preview.js";
import { siteSampleRunStore } from "../../src/server/plugins/integration/site-sample-runtime.js";
import { templateFixtureRunner } from "../../src/server/plugins/integration/library-fixtures.js";
import { SiteBuildArtifacts } from "../../src/server/builds/artifacts.js";
import { SiteBuildRetention } from "../../src/server/builds/retention.js";
import { SiteBuildError } from "../../src/server/builds/errors.js";
import { BuildRunReconciler } from "../../src/server/builds/runtime/reconciler.js";
import { legacyBuildRunDispatcher } from "../../src/server/builds/runtime/legacy-dispatch.js";
import type { SiteExecutor } from "../../src/server/builds/executor-port.js";
import type { BuildInput, BuildExecution, BuildArtifact } from "../../src/shared/builds/contracts.js";
import type { BuildAvailability } from "../../src/shared/builds/jobs.js";
import type { PluginPackage } from "../../src/shared/plugins/contracts.js";
import type { TemplateDefinition } from "../../src/shared/plugins/library.js";
import { profileThemePackage } from "./profile-theme-package.js";
import { exampleTemplateDefinition } from "./template-definition.mjs";

export const sampleHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function siteSampleDefinition(bundle: PluginPackage = profileThemePackage()): TemplateDefinition {
  return {
    schema: 1,
    package: bundle,
    archive: exampleTemplateDefinition().archive,
    fixtures: bundle.manifest.siteThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      kind: "site",
      exportId: theme.id,
      engine: theme.engine,
      title: "A fixed handbook",
      locale: "en",
      content: "# A fixed handbook\n\nA **clear** idea.\n",
      expectedDigest: null,
    })),
  };
}
export function sampleArtifact(): BuildArtifact {
  const files = [
    [
      "index.html",
      '<html><head><link rel="stylesheet" href="/site.css"><script>fetch("https://private.invalid")</script></head><body><h1 id="sample">A fixed handbook</h1><img src="https://private.invalid/private.png"></body></html>',
    ],
    ["site.css", "h1{color:#123456}body{font-family:Georgia,serif}"],
    ["sample/index.html", "<h1>A sample page</h1>"],
  ].map(([path, text]) => {
    const bytes = Buffer.from(text!);
    return { path: path!, data: bytes.toString("base64"), sha256: sampleHash(bytes) };
  });
  return {
    protocol: 1,
    bytes: files.reduce((total, file) => total + Buffer.from(file.data, "base64").length, 0),
    files,
  };
}
export class SampleExecutor implements SiteExecutor {
  available: BuildAvailability = {
    state: "ready",
    engines: { hexo: "8.1.1", docusaurus: "3.10.2" },
    themes: true,
    trustedThemes: true,
    profileThemes: true,
    siteProjects: true,
  };
  remote = new Map<string, BuildExecution>();
  inputs = new Map<string, BuildInput>();
  loseResponse = false;
  starts = 0;
  async availability() {
    return this.available;
  }
  async start(id: string, input: BuildInput) {
    this.starts++;
    let row = this.remote.get(id);
    if (!row) {
      row = {
        id,
        engine: input.engine,
        inputHash: sampleHash(JSON.stringify(input)),
        phase: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        image: { reference: "registry.example.test/worker:1", id: "sha256:" + "a".repeat(64), digest: null },
      };
      this.remote.set(id, row);
      this.inputs.set(id, structuredClone(input));
    }
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new SiteBuildError("executorUnavailable", 503);
    }
    return structuredClone(row);
  }
  async status(id: string) {
    const row = this.remote.get(id);
    if (!row) throw new SiteBuildError("executorMissing", 404);
    return structuredClone(row);
  }
  async cancel(id: string) {
    const row = await this.status(id);
    this.remote.set(id, { ...row, phase: "failed", error: "cancelled" });
    return this.status(id);
  }
  async result() {
    return sampleArtifact();
  }
  async logs() {
    return "A fixed sample build log";
  }
  complete(id: string) {
    const row = this.remote.get(id)!;
    this.remote.set(id, { ...row, phase: "completed" });
  }
}
export async function siteSampleFixture() {
  const root = await mkdtemp(join(tmpdir(), "panda-site-sample-")),
    databasePath = join(root, "plugins.sqlite");
  const db = openPluginDatabase(databasePath),
    registry = new PluginRegistryService(new SqlitePluginRegistry(db), new FilePluginBundles(join(root, "bundles")));
  const presentation = installedPresentation(registry),
    drafts = new SqliteTemplateLibrary(db),
    jobs = new SqliteSiteSamples(db),
    artifacts = new SiteBuildArtifacts(join(root, "samples")),
    executor = new SampleExecutor();
  const sources = siteSampleSources({ ...presentation, drafts, executor, authorize: presentation.authorizeBuild });
  const previewFixture = siteFixturePreview(jobs, artifacts),
    library = new TemplateLibraryService(drafts, templateFixtureRunner(previewFixture), registry);
  let now = Date.now();
  const monitors: BuildRunReconciler[] = [];
  const monitor = () => {
    const value = new BuildRunReconciler(
      siteSampleRunStore(jobs),
      artifacts,
      executor,
      () => {},
      new SiteBuildRetention(jobs, artifacts),
      legacyBuildRunDispatcher(siteSampleRunStore(jobs), executor, presentation.authorizeBuild),
      "site-sample",
      () => now,
    );
    monitors.push(value);
    return value;
  };
  const samples = new SiteSampleService(
    jobs,
    sources,
    () => {},
    (id) => artifacts.remove(id),
  );
  return {
    root,
    databasePath,
    db,
    registry,
    presentation,
    drafts,
    jobs,
    artifacts,
    executor,
    sources,
    library,
    samples,
    previewFixture,
    monitor,
    advance() {
      now += 60000;
    },
    async install(bundle: PluginPackage) {
      const review = await registry.review(bundle);
      return registry.install(
        bundle,
        { digest: review.digest, expectedRevision: review.revision, permissions: review.permissions },
        "owner",
      );
    },
    async dispose() {
      for (const value of monitors) value.stop();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
