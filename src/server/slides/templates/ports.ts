import type { MetadataStore } from "../../../shared/async-value.js";
import type {
  NativeSlidesDescriptorData,
  NativeSlidesInstallReceipt,
  OwnedNativeSlides,
} from "../../../shared/slides/registry.js";
import type { ImmutableVersions } from "../../packages/versions/contracts.js";
import type { NativeSlidesTemplate } from "./model.js";
import type { OwnedSourceReference } from "../../../shared/packages/ownership.js";

export type NativeSlidesRegistry = ImmutableVersions<NativeSlidesDescriptorData, NativeSlidesInstallReceipt>;
export interface NativeSlidesBodyStore {
  put(actor: string, operationId: string, template: NativeSlidesTemplate): Promise<OwnedNativeSlides>;
  with<T>(actor: string, ref: OwnedNativeSlides, run: (template: NativeSlidesTemplate) => Promise<T>): Promise<T>;
  recover(actor: string, operationId: string): Promise<OwnedNativeSlides | null>;
  reference(actor: string, operationId: string): OwnedSourceReference | null;
  remove(actor: string, operationId: string): Promise<void>;
}

export type NativeSlidesBodyMetadata = Omit<NativeSlidesBodyStore, "reference"> &
  MetadataStore<Pick<NativeSlidesBodyStore, "reference">>;
