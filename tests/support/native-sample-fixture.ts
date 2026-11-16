import { join } from "node:path";
import { nativeThemeFixture, nativeZipSource } from "./native-theme.js";
import { SampleExecutor } from "./site-sample-fixture.js";
import { ResourceBuildRequest } from "../../src/shared/builds/resources.js";
import { SiteBuildError } from "../../src/server/builds/errors.js";
import { SiteBuildArtifacts } from "../../src/server/builds/artifacts.js";
import { SiteBuildRetention } from "../../src/server/builds/retention.js";
import { FileResourceBuildInputs } from "../../src/server/builds/resource-inputs.js";
import { openNativeSampleDatabase } from "../../src/server/builds/native/database.js";
import { SqliteNativeSamples } from "../../src/server/builds/native/repository.js";
import { NativeSampleService } from "../../src/server/builds/native/service.js";
import { nativeSampleDispatcher } from "../../src/server/builds/native/dispatch.js";
import { BuildRunReconciler } from "../../src/server/builds/runtime/reconciler.js";
import { nativeBuildThemes } from "../../src/server/templates/integration/native-build-themes.js";
import type { ResourceBuildInputs } from "../../src/server/builds/resource-input-port.js";
import type { NativeBuildThemeRef } from "../../src/shared/builds/native-samples.js";

class NativeSampleExecutor extends SampleExecutor {
  resourceInputs = new Map<string, { digest: string; paths: string[]; logo: Uint8Array; content: string }>();
  constructor() {
    super();
    this.available.nativeResources = true;
  }
  async startResource(id: string, input: ResourceBuildRequest) {
    this.starts++;
    if (!this.remote.has(id)) {
      this.remote.set(id, {
        id,
        engine: input.engine,
        inputHash: input.digest,
        phase: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        image: { reference: "registry.example.test/native:fixture", id: "sha256:" + "b".repeat(64), digest: null },
      });
      this.resourceInputs.set(id, {
        digest: input.digest,
        paths: input.tree.files.map((file) => file.path),
        logo: input.tree.read("source/logo.bin"),
        content: input.descriptor.input.documents[0]!.content,
      });
    }
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new SiteBuildError("executorUnavailable", 503);
    }
    return this.status(id);
  }
}

export async function nativeSampleFixture(
  options: {
    files?: (files: ResourceBuildInputs) => ResourceBuildInputs;
  } = {},
) {
  const themes = await nativeThemeFixture(),
    root = join(themes.root, "samples"),
    executor = new NativeSampleExecutor(),
    artifacts = new SiteBuildArtifacts(join(root, "artifacts"));
  let now = Date.now(),
    themeService = themes.service();
  const monitors = new Set<BuildRunReconciler>();
  function open() {
    const db = openNativeSampleDatabase(join(root, "runs.sqlite")),
      jobs = new SqliteNativeSamples(db, () => now),
      original = new FileResourceBuildInputs(join(root, "inputs"), themes.owned.ingestion.runtime),
      files = options.files?.(original) ?? original,
      source = nativeBuildThemes(themeService),
      service = new NativeSampleService(
        jobs,
        files,
        source,
        executor,
        () => {},
        (id) => artifacts.remove(id),
        () => now,
      );
    return { db, jobs, files, source, service };
  }
  let state = open();
  async function stop() {
    await state.service.close();
    await Promise.all([...monitors].map((monitor) => monitor.drain()));
    monitors.clear();
    state.db.close();
  }
  return {
    root,
    themes,
    executor,
    artifacts,
    get samples() {
      return state.service;
    },
    get jobs() {
      return state.jobs;
    },
    get db() {
      return state.db;
    },
    get files() {
      return state.files;
    },
    get themeService() {
      return themeService;
    },
    advance(milliseconds = 60000) {
      now += milliseconds;
    },
    monitor() {
      const value = new BuildRunReconciler(
        state.jobs,
        artifacts,
        executor,
        () => {},
        new SiteBuildRetention(state.jobs, artifacts),
        nativeSampleDispatcher(state.jobs, state.files, state.source, executor),
        "native-sample",
        () => now,
      );
      monitors.add(value);
      return value;
    },
    async install(): Promise<NativeBuildThemeRef> {
      const { source } = await nativeZipSource(),
        command = await themes.command(themeService, source);
      const value = await themeService.install("owner", command.input),
        theme = value.current.themes[0]!;
      return { id: theme.id, version: theme.version, digest: theme.digest };
    },
    disable(ref: NativeBuildThemeRef) {
      themeService.state("owner", ref, "disable", themeService.snapshot("owner").revision);
    },
    async restart() {
      await stop();
      themeService = await themes.restart();
      state = open();
    },
    async dispose() {
      await stop();
      await themes.close();
    },
  };
}
