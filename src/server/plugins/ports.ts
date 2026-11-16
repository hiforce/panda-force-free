import type { PluginManifest, VerifiedPluginPackage } from "../../shared/plugins/contracts.js";
import type { InstalledPlugin, PluginRegistrySnapshot, PluginAuditEvent } from "../../shared/plugins/registry.js";
import type { PluginExportRef } from "../../shared/plugins/exports.js";
import type { PackagePermission } from "../../shared/plugins/contracts.js";
export type {
  InstalledPlugin,
  PluginRegistrySnapshot,
  PluginAuditEvent,
  PluginInstallReview,
} from "../../shared/plugins/registry.js";

export interface PluginMutation {
  expectedRevision: number;
  actor: string;
  now: number;
}
/** Storage owns atomic compare-and-write; domain services never select SQL or filesystem paths. */
export interface PluginRegistryStore {
  readonly asynchronous?: boolean;
  readonly transactionOwner?: object;
  snapshot(): PluginRegistrySnapshot;
  get(id: string, version: string): InstalledPlugin;
  install(
    manifest: PluginManifest,
    digest: string,
    selected: readonly PluginExportRef[],
    grants: readonly PackagePermission[],
    mutation: PluginMutation,
  ): InstalledPlugin;
  activate(id: string, version: string, mutation: PluginMutation): InstalledPlugin;
  setEnabled(id: string, version: string, enabled: boolean, mutation: PluginMutation): InstalledPlugin;
  setExportEnabled(
    id: string,
    version: string,
    entry: PluginExportRef,
    enabled: boolean,
    mutation: PluginMutation,
  ): InstalledPlugin;
  activateExport(id: string, version: string, entry: PluginExportRef, mutation: PluginMutation): InstalledPlugin;
  audit(after?: number, limit?: number): PluginAuditEvent[];
}
export interface PluginBundleStore {
  put(value: VerifiedPluginPackage): Promise<void>;
  read(digest: string): Promise<VerifiedPluginPackage>;
}

export interface PluginApproval {
  digest: string;
  expectedRevision: number;
  permissions: import("../../shared/plugins/contracts.js").PackagePermission[];
  selected?: readonly PluginExportRef[];
  reviewHash?: string;
}
export interface PreparedPluginInstall<T = InstalledPlugin> {
  readonly asynchronous?: boolean;
  readonly transactionOwner?: object;
  commit(): T;
}
export interface LibraryInstaller {
  prepareInstall(
    value: unknown,
    approval: PluginApproval,
    actor: string,
  ): Promise<PreparedPluginInstall<InstalledPlugin | Promise<InstalledPlugin>>>;
}
export interface TemplateLibraryStore {
  readonly asynchronous?: boolean;
  readonly transactionOwner?: object;
  snapshot(): import("../../shared/plugins/library.js").TemplateLibrarySnapshot;
  get(id: string): import("../../shared/plugins/library.js").TemplateDraft;
  save(
    value: import("../../shared/plugins/library.js").TemplateDefinition,
    digest: string,
    packageDigest: string,
    id: string,
    revision: number | null,
    actor: string,
    now: number,
  ): import("../../shared/plugins/library.js").TemplateDraft;
  validate(
    id: string,
    revision: number,
    report: import("../../shared/plugins/library.js").TemplateValidation,
    actor: string,
    now: number,
  ): import("../../shared/plugins/library.js").TemplateDraft;
  publish(
    id: string,
    revision: number,
    digest: string,
    actor: string,
    now: number,
    commit: () => InstalledPlugin,
  ): import("../../shared/plugins/library.js").TemplateRelease;
  release(id: string, version: string): import("../../shared/plugins/library.js").TemplateRelease;
  remove(id: string, revision: number, actor: string, now: number): void;
}
export interface TemplateFixtureRunner {
  readonly version: string;
  preview(
    definition: import("../../shared/plugins/library.js").TemplateDefinition,
    fixture: import("../../shared/plugins/library.js").TemplateFixture,
  ): Promise<import("../../shared/plugins/library.js").TemplateFixturePreview>;
}

export interface SiteSampleCapture {
  key: string;
  context: import("../../shared/plugins/site-samples.js").SiteSampleContext;
  input: import("../../shared/builds/contracts.js").BuildInput & {
    theme: import("../../shared/builds/theme.js").BuildThemeSnapshot;
  };
}
/** Structurally implements the shared build monitor port without depending on its concrete runtime. */
export interface SiteSampleStore {
  existing(
    request: import("../../shared/plugins/site-samples.js").SiteSampleRequest,
    actor: string,
  ): import("../../shared/plugins/site-samples.js").SiteSampleBuild | null;
  create(
    request: import("../../shared/plugins/site-samples.js").SiteSampleRequest,
    capture: SiteSampleCapture,
    actor: string,
  ): import("../../shared/plugins/site-samples.js").SiteSampleBuild;
  owner(id: string): string;
  get(id: string): import("../../shared/plugins/site-samples.js").SiteSampleBuild;
  input(id: string): import("../../shared/builds/contracts.js").BuildInput;
  active(): import("../../shared/plugins/site-samples.js").SiteSampleBuild[];
  artifacts(): import("../../shared/plugins/site-samples.js").SiteSampleBuild[];
  list(actor: string): import("../../shared/plugins/site-samples.js").SiteSampleBuild[];
  latest(key: string, actor?: string): import("../../shared/plugins/site-samples.js").SiteSampleBuild | null;
  update(
    id: string,
    changes: import("../../shared/builds/run.js").BuildRunChanges,
  ): import("../../shared/plugins/site-samples.js").SiteSampleBuild;
  logs(id: string): string;
  saveLogs(id: string, value: string): void;
  remove(id: string): void;
}
export interface SiteSampleSources {
  capture(source: import("../../shared/plugins/site-samples.js").SiteSampleSource): Promise<SiteSampleCapture>;
  assertAvailable(input: import("../../shared/builds/contracts.js").BuildInput): Promise<void>;
  authorize(input: import("../../shared/builds/contracts.js").BuildInput): void | Promise<void>;
}
