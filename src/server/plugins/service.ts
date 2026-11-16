import { mapMetadata, type MetadataStore, type MetadataValue } from "../../shared/async-value.js";
import type { VerifiedPluginPackage } from "../../shared/plugins/contracts.js";
import { verifyPluginPackage } from "../../shared/plugins/package.js";
import { packageId, packageVersion, canonicalPackageJson, packageSha256 } from "../../shared/plugins/validation.js";
import {
  pluginExportPermissions,
  samePluginExport,
  selectPluginExports,
  type PluginExportRef,
} from "../../shared/plugins/exports.js";
import { PluginRegistryError } from "./errors.js";
import type {
  PluginBundleStore,
  PluginInstallReview,
  PluginMutation,
  PluginRegistryStore,
  PluginApproval,
  PreparedPluginInstall,
  InstalledPlugin,
  PluginRegistrySnapshot,
  PluginAuditEvent,
} from "./ports.js";
export type { PluginApproval } from "./ports.js";
/** Request identity is injected by a trusted boundary, never read from the package or approval payload. */
export class PluginRegistryService<S extends MetadataStore<PluginRegistryStore> = PluginRegistryStore> {
  constructor(
    private registry: S,
    private bundles: PluginBundleStore,
    private now: () => number = Date.now,
  ) {}
  snapshot(): MetadataValue<S, PluginRegistryStore, PluginRegistrySnapshot> {
    return this.registry.snapshot() as MetadataValue<S, PluginRegistryStore, PluginRegistrySnapshot>;
  }
  async review(value: unknown, selected?: unknown): Promise<PluginInstallReview> {
    const verified = await verifyPluginPackage(value);
    return this.reviewVerified(verified, selected);
  }
  private async reviewVerified(value: VerifiedPluginPackage, selection?: unknown): Promise<PluginInstallReview> {
    const { manifest } = value.package,
      snapshot = await this.registry.snapshot(),
      prior = snapshot.packages.find((item) => item.id === manifest.id && item.active),
      installed = snapshot.packages.find((item) => item.id === manifest.id && item.version === manifest.version);
    if (installed && installed.digest !== value.digest) throw new PluginRegistryError("immutableVersion");
    const selected = selectPluginExports(manifest, selection),
      permissions = pluginExportPermissions(manifest, selected);
    const priorSelectedPermissions = snapshot.packages
      .filter((pack) => pack.id === manifest.id && pack.enabled)
      .flatMap((pack) =>
        pluginExportPermissions(
          pack.manifest,
          pack.exports.filter(
            (entry) => entry.enabled && entry.active && selected.some((item) => samePluginExport(item, entry)),
          ),
        ),
      );
    const previousGrants = installed?.grants || [...new Set(priorSelectedPermissions)];
    const reviewHash = await packageSha256(
      canonicalPackageJson({ digest: value.digest, revision: snapshot.revision, selected, permissions }),
    );
    return {
      id: manifest.id,
      version: manifest.version,
      digest: value.digest,
      revision: snapshot.revision,
      manifest: structuredClone(manifest),
      selected,
      reviewHash,
      permissions,
      addedPermissions: permissions.filter((item) => !previousGrants.includes(item)),
      removedPermissions: installed ? [] : previousGrants.filter((item) => !permissions.includes(item)),
      activeVersion: prior?.version || null,
      installed: !!installed,
      fileCount: value.fileCount,
      byteLength: value.byteLength,
    };
  }
  async install(value: unknown, approval: PluginApproval, actor: string) {
    return (await this.prepareInstall(value, approval, actor)).commit();
  }
  async prepareInstall(
    value: unknown,
    approval: PluginApproval,
    actor: string,
  ): Promise<PreparedPluginInstall<MetadataValue<S, PluginRegistryStore, InstalledPlugin>>> {
    const verified = await verifyPluginPackage(value),
      review = await this.reviewVerified(verified, approval?.selected);
    if (!approval || approval.digest !== verified.digest) throw new PluginRegistryError("reviewChanged");
    if (
      (approval.selected !== undefined || approval.reviewHash !== undefined) &&
      approval.reviewHash !== review.reviewHash
    )
      throw new PluginRegistryError("reviewChanged");
    if (
      !Array.isArray(approval.permissions) ||
      new Set(approval.permissions).size !== approval.permissions.length ||
      approval.permissions.length !== review.permissions.length ||
      review.permissions.some((item) => !approval.permissions.includes(item))
    )
      throw new PluginRegistryError("approvalRequired");
    const mutation = this.mutation(approval.expectedRevision, actor);
    if (review.revision !== approval.expectedRevision) throw new PluginRegistryError("registryConflict");
    // Complete immutable data is durable before a transactional registry reference becomes visible.
    // A concurrent registry write may leave an unreferenced bundle, never an installed missing bundle.
    await this.bundles.put(verified);
    return {
      asynchronous: this.registry.asynchronous === true,
      transactionOwner: this.registry.transactionOwner,
      commit: () =>
        this.registry.install(
          verified.package.manifest,
          verified.digest,
          review.selected,
          review.permissions,
          mutation,
        ) as MetadataValue<S, PluginRegistryStore, InstalledPlugin>,
    };
  }
  async capture(id: string, version: string): Promise<VerifiedPluginPackage> {
    packageId(id);
    packageVersion(version);
    const installed = await this.registry.get(id, version);
    if (!installed.enabled) throw new PluginRegistryError("packageDisabled");
    const bundle = await this.bundles.read(installed.digest);
    if (bundle.package.manifest.id !== id || bundle.package.manifest.version !== version)
      throw new PluginRegistryError("packageUnavailable");
    // A disable that happened during disk IO must prevent a new build capture.
    await this.assertEnabled(id, version, installed.digest);
    return bundle;
  }
  /** Export is read-only and never grants execution authority, including for disabled versions. */
  async exportPackage(id: string, version: string): Promise<VerifiedPluginPackage> {
    packageId(id);
    packageVersion(version);
    const installed = await this.registry.get(id, version);
    const bundle = await this.bundles.read(installed.digest);
    if (
      bundle.digest !== installed.digest ||
      bundle.package.manifest.id !== id ||
      bundle.package.manifest.version !== version
    )
      throw new PluginRegistryError("packageUnavailable");
    return bundle;
  }
  assertEnabled(id: string, version: string, digest: string): MetadataValue<S, PluginRegistryStore, void> {
    return mapMetadata(this.registry.get(id, version), (value) => {
      if (!value.enabled) throw new PluginRegistryError("packageDisabled");
      if (value.digest !== digest) throw new PluginRegistryError("reviewChanged");
    }) as MetadataValue<S, PluginRegistryStore, void>;
  }
  assertExportEnabled(
    id: string,
    version: string,
    digest: string,
    entry: PluginExportRef,
  ): MetadataValue<S, PluginRegistryStore, InstalledPlugin> {
    return mapMetadata(this.registry.get(id, version), (value) => {
      if (!value.enabled) throw new PluginRegistryError("packageDisabled");
      if (value.digest !== digest) throw new PluginRegistryError("reviewChanged");
      const selected = selectPluginExports(value.manifest, [entry])[0]!;
      if (!value.exports.some((item) => samePluginExport(item, selected) && item.enabled))
        throw new PluginRegistryError("exportUnavailable");
      if (pluginExportPermissions(value.manifest, [selected]).some((permission) => !value.grants.includes(permission)))
        throw new PluginRegistryError("approvalRequired");
      return value;
    }) as MetadataValue<S, PluginRegistryStore, InstalledPlugin>;
  }
  async captureExport(id: string, version: string, entry: PluginExportRef): Promise<VerifiedPluginPackage> {
    const value = await this.registry.get(packageId(id), packageVersion(version));
    await this.assertExportEnabled(id, version, value.digest, entry);
    const bundle = await this.capture(id, version);
    await this.assertExportEnabled(id, version, bundle.digest, entry);
    return bundle;
  }
  async activate(id: string, version: string, expectedRevision: number, actor: string) {
    const mutation = this.mutation(expectedRevision, actor);
    await this.capture(id, version);
    return await this.registry.activate(id, version, mutation);
  }
  setEnabled(
    id: string,
    version: string,
    enabled: boolean,
    expectedRevision: number,
    actor: string,
  ): MetadataValue<S, PluginRegistryStore, InstalledPlugin> {
    packageId(id);
    packageVersion(version);
    if (typeof enabled !== "boolean") throw new PluginRegistryError("reviewChanged");
    return this.registry.setEnabled(id, version, enabled, this.mutation(expectedRevision, actor)) as MetadataValue<
      S,
      PluginRegistryStore,
      InstalledPlugin
    >;
  }
  setExportEnabled(
    id: string,
    version: string,
    entry: PluginExportRef,
    enabled: boolean,
    expectedRevision: number,
    actor: string,
  ): MetadataValue<S, PluginRegistryStore, InstalledPlugin> {
    return mapMetadata(this.registry.get(packageId(id), packageVersion(version)), (value) => {
      const selected = selectPluginExports(value.manifest, [entry])[0]!;
      if (typeof enabled !== "boolean") throw new PluginRegistryError("reviewChanged");
      return this.registry.setExportEnabled(id, version, selected, enabled, this.mutation(expectedRevision, actor));
    }) as MetadataValue<S, PluginRegistryStore, InstalledPlugin>;
  }
  async activateExport(id: string, version: string, entry: PluginExportRef, expectedRevision: number, actor: string) {
    const mutation = this.mutation(expectedRevision, actor);
    await this.captureExport(id, version, entry);
    return await this.registry.activateExport(id, version, entry, mutation);
  }
  audit(after?: number, limit?: number): MetadataValue<S, PluginRegistryStore, PluginAuditEvent[]> {
    return this.registry.audit(after, limit) as MetadataValue<S, PluginRegistryStore, PluginAuditEvent[]>;
  }
  private mutation(expectedRevision: number, actor: string): PluginMutation {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new PluginRegistryError("registryConflict");
    if (typeof actor !== "string" || !actor.trim() || actor.length > 200 || /[\p{Cc}\p{Cf}]/u.test(actor))
      throw new PluginRegistryError("approvalRequired");
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new PluginRegistryError("reviewChanged");
    return { expectedRevision, actor, now };
  }
}
export type PluginRegistryServicePort = PluginRegistryService<MetadataStore<PluginRegistryStore>>;
