import type { BuildEngine } from "../builds/engines.js";
import type { ChannelTemplateStyle } from "../presentation/template-snapshot.js";
import type { PublicationFormat } from "../publishing/content.js";
import type { SiteThemeProfile } from "../presentation/theme-profile.js";

export type PackagePermission = "content:site-themes" | "content:templates" | "build:theme-code";
export interface PackageLabel {
  name: string;
  description: string;
  labels?: Record<string, { name: string; description: string }>;
}
export interface PackageCodeTheme extends PackageLabel {
  id: string;
  engine: BuildEngine;
  engineVersion: string;
  root: string;
  /** Docusaurus loads this entry inside the isolated engine worker, relative to root. */
  entry?: string;
  /** Exact preinstalled module versions, checked in the worker; packages never trigger installation. */
  dependencies?: Record<string, string>;
}
export interface PackageProfileTheme extends PackageLabel {
  kind: "profile";
  id: string;
  engine: BuildEngine;
  profile: SiteThemeProfile;
}
export type PackageSiteTheme = PackageCodeTheme | PackageProfileTheme;
export const isProfileTheme = (value: PackageSiteTheme): value is PackageProfileTheme =>
  "kind" in value && value.kind === "profile";
export interface PackageChannelTemplate extends PackageLabel {
  id: string;
  formats: PublicationFormat[];
  style: Omit<ChannelTemplateStyle, "version">;
}
export interface PluginManifest extends PackageLabel {
  schema: 1;
  id: string;
  version: string;
  permissions: PackagePermission[];
  siteThemes: PackageSiteTheme[];
  channelTemplates: PackageChannelTemplate[];
}
export interface PluginPackageFile {
  path: string;
  /** Canonical padded base64, decoded only after bounded validation. */
  data: string;
  sha256: string;
}
export interface PluginPackage {
  schema: 1;
  manifest: PluginManifest;
  files: PluginPackageFile[];
}
export interface VerifiedPluginPackage {
  package: PluginPackage;
  digest: string;
  fileCount: number;
  byteLength: number;
}
export const PACKAGE_LIMITS = Object.freeze({
  files: 512,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  jsonBytes: 12 * 1024 * 1024,
  exports: 32,
});
export type PackageErrorCode =
  | "invalidPackage"
  | "packageTooLarge"
  | "unsupportedPermission"
  | "permissionMismatch"
  | "incompatibleEngine"
  | "invalidPackagePath"
  | "packageDigestMismatch";
/** Portable validation returns stable codes; presentation boundaries own translation. */
export class PluginPackageError extends Error {
  constructor(readonly code: PackageErrorCode) {
    super(code);
    this.name = "PluginPackageError";
  }
}
