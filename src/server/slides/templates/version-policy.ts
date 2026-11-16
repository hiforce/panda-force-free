import type { NativeSlidesDescriptorData, NativeSlidesInstallReceipt } from "../../../shared/slides/registry.js";
import { NativeSlidesDescriptor, NATIVE_SLIDES_DESCRIPTOR_BYTES, nativeSlidesDescriptorData } from "./descriptor.js";
import type { VersionPolicy } from "../../packages/versions/contracts.js";
export const nativeSlidesVersionPolicy: VersionPolicy<NativeSlidesDescriptorData, NativeSlidesInstallReceipt> = {
  maxBytes: NATIVE_SLIDES_DESCRIPTOR_BYTES,
  trusted: (value): value is NativeSlidesDescriptor => value instanceof NativeSlidesDescriptor,
  parse: nativeSlidesDescriptorData,
  identity: (value) => ({
    id: value.manifest.settings.id,
    version: value.manifest.settings.version,
    sourceDigest: value.sourceDigest,
  }),
  receipt: ({ descriptor, operationId, revision, digest, status }) => ({
    operationId,
    revision,
    id: descriptor.manifest.settings.id,
    version: descriptor.manifest.settings.version,
    digest,
    templateDigest: descriptor.templateDigest,
    sourceDigest: descriptor.sourceDigest,
    importedSourceDigest: descriptor.importedFrom.digest,
    status,
  }),
};
