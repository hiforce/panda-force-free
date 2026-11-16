import type { MetadataStore, MetadataValue } from "../../shared/async-value.js";
import type { TemplateLibrarySnapshot, TemplateRelease } from "../../shared/plugins/library.js";
import type { InstalledPlugin } from "./ports.js";
import { randomUUID } from "node:crypto";
import { verifyTemplateDefinition, templateFixtureCoverage } from "../../shared/plugins/library-validation.js";
import type {
  TemplateDraft,
  TemplateValidation,
  TemplateFixtureResult,
  TemplateDraftPreview,
} from "../../shared/plugins/library.js";
import { packageId, packageVersion } from "../../shared/plugins/validation.js";
import type { TemplateLibraryStore, TemplateFixtureRunner, LibraryInstaller, PluginApproval } from "./ports.js";
import { PluginRegistryError } from "./errors.js";
import { readVerifiedTemplateDraft } from "./definition.js";
const revision = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new PluginRegistryError("invalidLibraryDraft");
  return Number(value);
};
const identity = (value: string) => {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new PluginRegistryError("invalidLibraryDraft");
  return value;
};
function actorName(actor: string) {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 200 || /[\p{Cc}\p{Cf}]/u.test(actor))
    throw new PluginRegistryError("identityRequired");
  return actor;
}
/** Drafts, fixed samples and version archives share no publication credentials or external channel operations. */
export type TemplateLibraryMetadata = Omit<MetadataStore<TemplateLibraryStore>, "publish"> & {
  publish:
    | TemplateLibraryStore["publish"]
    | ((
        id: string,
        revision: number,
        digest: string,
        actor: string,
        now: number,
        commit: () => InstalledPlugin | Promise<InstalledPlugin>,
      ) => TemplateRelease | Promise<TemplateRelease>);
};
export class TemplateLibraryService<S extends TemplateLibraryMetadata = TemplateLibraryStore> {
  private active = new Set<string>();
  constructor(
    private store: S,
    private runner: TemplateFixtureRunner,
    private installer: LibraryInstaller,
    private now = Date.now,
  ) {}
  snapshot(): MetadataValue<S, TemplateLibraryStore, TemplateLibrarySnapshot> {
    return this.store.snapshot() as MetadataValue<S, TemplateLibraryStore, TemplateLibrarySnapshot>;
  }
  async detail(id: string) {
    return readVerifiedTemplateDraft(this.store, identity(id));
  }
  async save(input: unknown, actor: string, id?: string, expected?: unknown) {
    actorName(actor);
    const checked = await verifyTemplateDefinition(input);
    return this.store.save(
      checked.definition,
      checked.digest,
      checked.packageDigest,
      id ? identity(id) : randomUUID(),
      id ? revision(expected) : null,
      actor,
      this.now(),
    );
  }
  async fork(id: string, version: string, actor: string) {
    const previous = await this.detail(id),
      definition = structuredClone(previous.definition);
    definition.package.manifest.version = packageVersion(version);
    if (version === previous.manifest.version) throw new PluginRegistryError("immutableVersion");
    return this.save(definition, actor);
  }
  async forkRelease(id: string, fromVersion: string, version: string, actor: string) {
    const previous = await this.release(id, fromVersion),
      definition = structuredClone(previous.definition);
    definition.package.manifest.version = packageVersion(version);
    if (version === fromVersion) throw new PluginRegistryError("immutableVersion");
    return this.save(definition, actor);
  }
  async acceptBaseline(id: string, expected: unknown, fixtureId: string, digest: string, actor: string) {
    actorName(actor);
    const value = await this.detail(id);
    this.requireRevision(value, expected);
    const fixture = value.definition.fixtures.find((item) => item.id === fixtureId);
    if (!fixture) throw new PluginRegistryError("libraryNotFound");
    const result = await this.runner.preview(value.definition, fixture);
    if (result.actualDigest !== digest || ["blocked", "requiresBuild"].includes(result.state) || !result.actualDigest)
      throw new PluginRegistryError("libraryUnverified");
    fixture.expectedDigest = result.actualDigest;
    return this.save(value.definition, actor, id, expected);
  }
  async preview(id: string, fixtureId: string): Promise<TemplateDraftPreview> {
    const value = await this.detail(id),
      fixture = value.definition.fixtures.find((item) => item.id === fixtureId);
    if (!fixture) throw new PluginRegistryError("libraryNotFound");
    const result = await this.runner.preview(value.definition, fixture);
    if ((await this.store.get(id)).revision !== value.revision) throw new PluginRegistryError("libraryConflict");
    return { ...result, definitionDigest: value.digest, draftRevision: value.revision };
  }
  async validate(id: string, expected: unknown, actor: string) {
    actorName(actor);
    revision(expected);
    if (this.active.has(id) || this.active.size >= 2) throw new PluginRegistryError("libraryConflict");
    this.active.add(id);
    try {
      const value = await this.detail(id);
      this.requireRevision(value, expected);
      const results: TemplateFixtureResult[] = [];
      for (const fixture of value.definition.fixtures) {
        const {
          html: _html,
          text: _text,
          posts: _posts,
          siteBuild: _build,
          sitePages: _pages,
          ...result
        } = await this.runner.preview(value.definition, fixture);
        results.push(result);
      }
      const missingCoverage = templateFixtureCoverage(value.definition);
      const report: TemplateValidation = {
        definitionDigest: value.digest,
        runnerVersion: this.runner.version,
        checkedAt: this.now(),
        results,
        missingCoverage,
        passed: !missingCoverage.length && results.length > 0 && results.every((item) => item.state === "passed"),
      };
      return await this.store.validate(id, value.revision, report, actor, this.now());
    } finally {
      this.active.delete(id);
    }
  }
  async publish(id: string, expected: unknown, digest: string, approval: PluginApproval, actor: string) {
    actorName(actor);
    const value = await this.detail(id);
    if (value.publishedAt !== null) {
      if (value.digest !== digest || !Number.isSafeInteger(expected) || Number(expected) !== value.revision - 1)
        throw new PluginRegistryError("libraryConflict");
      return this.release(value.manifest.id, value.manifest.version);
    }
    this.requireRevision(value, expected);
    if (
      value.digest !== digest ||
      !value.validation?.passed ||
      value.validation.definitionDigest !== value.digest ||
      value.validation.runnerVersion !== this.runner.version
    )
      throw new PluginRegistryError("libraryUnverified");
    const prepared = await this.installer.prepareInstall(value.definition.package, approval, actor);
    if (
      (prepared.asynchronous === true) !== (this.store.asynchronous === true) ||
      (prepared.asynchronous &&
        (!prepared.transactionOwner || prepared.transactionOwner !== this.store.transactionOwner))
    )
      throw new PluginRegistryError("packageUnavailable");
    return await this.store.publish(
      value.id,
      value.revision,
      value.digest,
      actor,
      this.now(),
      () => prepared.commit() as InstalledPlugin,
    );
  }
  async release(id: string, version: string) {
    const value = await this.store.release(packageId(id), packageVersion(version)),
      checked = await verifyTemplateDefinition(value.definition);
    if (value.digest !== checked.digest || value.packageDigest !== checked.packageDigest)
      throw new PluginRegistryError("packageUnavailable");
    return value;
  }
  remove(id: string, expected: unknown, actor: string): MetadataValue<S, TemplateLibraryStore, void> {
    actorName(actor);
    return this.store.remove(identity(id), revision(expected), actor, this.now()) as MetadataValue<
      S,
      TemplateLibraryStore,
      void
    >;
  }
  private requireRevision(value: TemplateDraft, expected: unknown) {
    if (value.revision !== revision(expected)) throw new PluginRegistryError("libraryConflict");
    if (value.publishedAt !== null) throw new PluginRegistryError("libraryPublished");
  }
}
export type TemplateLibraryServicePort = TemplateLibraryService<TemplateLibraryMetadata>;
