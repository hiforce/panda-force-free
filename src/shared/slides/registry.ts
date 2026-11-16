import type { PackageSourceOrigin } from "../packages/sources/contracts.js";
import type { NativeSlidesBundleManifest, NativeSlidesSettings } from "./templates.js";
import type { OwnedSourceReference } from "../packages/ownership.js";
import type { NativePresentationIndex } from "./contracts.js";
import type { NativeContentMapping } from "./mapping.js";

export interface OwnedNativeSlides {
  readonly source: OwnedSourceReference;
  readonly templateDigest: string;
}

export type NativeSlidesSelection =
  | { readonly kind: "archive" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "bundle"; readonly root: string };
export interface NativeSlidesProvenance {
  readonly digest: string;
  readonly origin: Readonly<PackageSourceOrigin>;
  readonly selection: NativeSlidesSelection;
}
export interface NativeSlidesDescriptorData {
  readonly schema: "panda.native-slides-template/v1";
  readonly manifest: NativeSlidesBundleManifest;
  readonly templateDigest: string;
  readonly sourceDigest: string;
  readonly importedFrom: NativeSlidesProvenance;
}
export interface NativeSlidesInstallReceipt {
  readonly operationId: string;
  readonly revision: number;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly templateDigest: string;
  readonly sourceDigest: string;
  readonly importedSourceDigest: string;
  readonly status: "installed" | "retained";
}
export interface InstalledNativeSlides {
  id: string;
  version: string;
  digest: string;
  descriptor: NativeSlidesDescriptorData;
  enabled: boolean;
  active: boolean;
  installedAt: number;
}
export interface NativeSlidesSnapshot {
  revision: number;
  templates: InstalledNativeSlides[];
}
export interface NativeSlidesApproval {
  operationId: string;
  expectedRevision: number;
  reviewHash: string;
  licenseAcknowledged: true;
}
export interface NativeSlidesSourceReference {
  readonly id: string;
  readonly sha256: string;
  readonly selection: NativeSlidesSelection;
}
export interface NativeSlidesDefinition {
  readonly settings: NativeSlidesSettings;
  readonly mapping: NativeContentMapping;
  readonly licenseText: string;
  readonly readmeText: string;
}
export interface NativeSlidesInput {
  readonly source: NativeSlidesSourceReference;
  readonly definition: NativeSlidesDefinition | null;
}
export interface NativeSlidesProposal {
  readonly original: NativePresentationIndex;
  readonly importedFrom: NativeSlidesProvenance;
  readonly definition: NativeSlidesDefinition | null;
}
export interface NativeSlidesReview {
  readonly revision: number;
  readonly reviewHash: string;
  readonly digest: string;
  readonly descriptor: NativeSlidesDescriptorData;
  readonly installed: boolean;
  readonly licenseText: string;
  readonly licenseAcknowledgementRequired: true;
}
export interface NativeSlidesInstallResult {
  readonly receipt: NativeSlidesInstallReceipt;
  readonly current: NativeSlidesSnapshot;
}
