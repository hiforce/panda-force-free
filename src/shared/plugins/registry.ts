import type { PackagePermission, PluginManifest } from "./contracts.js";
import type { InstalledPluginExport, PluginExportRef } from "./exports.js";

/** Browser-visible installation metadata never includes executable package files or credential data. */
export interface InstalledPlugin {
  id: string;
  version: string;
  digest: string;
  manifest: PluginManifest;
  installedAt: number;
  installedBy: string;
  enabled: boolean;
  active: boolean;
  exports: InstalledPluginExport[];
  grants: PackagePermission[];
}
export interface PluginRegistrySnapshot {
  revision: number;
  packages: InstalledPlugin[];
}
export interface PluginAuditEvent {
  sequence: number;
  revision: number;
  action: "install" | "activate" | "enable" | "disable" | "exports";
  id: string;
  version: string;
  digest: string;
  actor: string;
  permissions: PackagePermission[];
  createdAt: number;
  exports: InstalledPluginExport[];
}
export interface PluginInstallReview {
  id: string;
  version: string;
  digest: string;
  revision: number;
  manifest: PluginManifest;
  permissions: PackagePermission[];
  addedPermissions: PackagePermission[];
  removedPermissions: PackagePermission[];
  activeVersion: string | null;
  installed: boolean;
  fileCount: number;
  byteLength: number;
  selected: PluginExportRef[];
  reviewHash: string;
}
