import type { ImmutableTemplate, PortableTemplateManifest } from "./contracts.js";
import type { PortableTemplateErrorCode } from "./errors.js";
import type { PackageSourceOrigin } from "../../packages/sources/contracts.js";

export type PortableTemplateOrigin =
  | { kind: "upload"; name: string; sha256: string }
  | { kind: "captured"; source: Readonly<PackageSourceOrigin>; root: string; sha256: string }
  | { kind: "authoring"; draftId: string; revision: number; digest: string; sha256: string };
export interface InstalledPortableTemplate {
  id: string;
  version: string;
  digest: string;
  manifest: ImmutableTemplate<PortableTemplateManifest>;
  origin: PortableTemplateOrigin;
  enabled: boolean;
  active: boolean;
  installedAt: number;
  installedBy: string;
}
export interface PortableRegistrySnapshot {
  revision: number;
  templates: InstalledPortableTemplate[];
}
export interface PortableTemplateCandidate {
  key: string;
  digest: string;
  manifest: ImmutableTemplate<PortableTemplateManifest>;
  supported: boolean;
  issue: PortableTemplateErrorCode | null;
  installed: boolean;
}
export interface PortableTemplateReview {
  revision: number;
  source: PortableTemplateOrigin;
  reviewHash: string;
  selected: string[];
  candidates: PortableTemplateCandidate[];
}
export interface PortableInstallReceipt {
  operationId: string;
  revision: number;
  source: PortableTemplateOrigin;
  results: { id: string; version: string; digest: string; status: "installed" | "retained" }[];
}
export interface PortableInstallResult {
  receipt: PortableInstallReceipt;
  current: PortableRegistrySnapshot;
}
