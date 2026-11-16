import type { BuildEngine } from "../../builds/engines.js";
import type { PackageSourceOrigin, SourceFile } from "../../packages/sources/contracts.js";

export class NativeThemeError extends Error {
  constructor(
    readonly code:
      | "invalidInput"
      | "notFound"
      | "busy"
      | "unavailable"
      | "conflict"
      | "immutableVersion"
      | "reviewChanged"
      | "executionNotApproved"
      | "disabled"
      | "storageFull"
      | "incompleteSource"
      | "exportTooLarge",
  ) {
    super(code);
    this.name = "NativeThemeError";
  }
}
export interface NativeThemeSettings {
  schema: 1;
  id: string;
  version: string;
  name: Readonly<Record<string, string>>;
  description: Readonly<Record<string, string>>;
  publisher: string;
  license: { expression: string; file: string };
  readme: string | null;
  engine: BuildEngine;
  entry: string | null;
  dependencies: Record<string, string>;
}
export interface NativeThemeDescriptorData {
  schema: "panda.native-site-theme/v1";
  settings: NativeThemeSettings;
  source: { digest: string; origin: Readonly<PackageSourceOrigin> };
  root: string;
  projection: { digest: string; treeDigest: string; files: readonly SourceFile[] };
  license: SourceFile;
}
export interface InstalledNativeTheme {
  id: string;
  version: string;
  digest: string;
  descriptor: Readonly<NativeThemeDescriptorData>;
  enabled: boolean;
  active: boolean;
  installedAt: number;
}
export interface NativeThemeSnapshot {
  revision: number;
  themes: InstalledNativeTheme[];
}
export interface NativeThemeSummary extends Omit<InstalledNativeTheme, "descriptor"> {
  settings: Readonly<NativeThemeSettings>;
  source: NativeThemeDescriptorData["source"];
  root: string;
  files: number;
  bytes: number;
}
export interface NativeThemeList {
  revision: number;
  themes: NativeThemeSummary[];
}
export interface NativeThemeApproval {
  operationId: string;
  expectedRevision: number;
  reviewHash: string;
  permissions: readonly ["build:theme-code"];
  licenseAcknowledged: true;
}
export interface NativeThemeReceipt {
  operationId: string;
  revision: number;
  sourceDigest: string;
  root: string;
  settingsDigest: string;
  id: string;
  version: string;
  digest: string;
  status: "installed" | "retained";
}
export interface NativeThemeReview {
  revision: number;
  reviewHash: string;
  digest: string;
  descriptor: Readonly<NativeThemeDescriptorData>;
  licenseText: string;
  sourceFiles: number;
  installed: boolean;
  requiredPermissions: readonly ["build:theme-code"];
}
export interface NativeThemeSourceRef {
  id: string;
  digest: string;
}
export interface NativeThemeSourceSelection {
  id: string;
  sha256: string;
  root: string;
}
export interface NativeThemeInput {
  source: NativeThemeSourceSelection;
  settings: NativeThemeSettings;
}
export interface NativeThemeProposal {
  bundle?: { themeDigest: string; projectionDigest: string };
  settings: NativeThemeSettings;
  licenseFiles: string[];
  licenseText: string;
  readmeText: string;
  issues: { path: string; code: "metadataInvalid" | "metadataTooLarge" }[];
}
export interface NativeThemeInstallResult {
  receipt: NativeThemeReceipt;
  current: NativeThemeSnapshot;
}
export interface NativeThemeIntent {
  actor: string;
  operationId: string;
  signature: string;
  state: "pending" | "committed" | "failed";
  expectedRevision: number;
  descriptor: Readonly<NativeThemeDescriptorData> | null;
  digest: string;
  receipt: NativeThemeReceipt | null;
  cleaned: boolean;
  recoverAfter: number;
}
