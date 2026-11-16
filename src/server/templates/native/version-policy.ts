import type { NativeThemeDescriptorData, NativeThemeReceipt } from "../../../shared/templates/native/contracts.js";
import {
  NativeThemeDescriptor,
  NATIVE_THEME_METADATA_BYTES,
  nativeThemeDescriptorData,
} from "../../../shared/templates/native/descriptor.js";
import type { VersionPolicy } from "../../packages/versions/contracts.js";
export const nativeThemeVersionPolicy: VersionPolicy<NativeThemeDescriptorData, NativeThemeReceipt> = {
  maxBytes: NATIVE_THEME_METADATA_BYTES,
  trusted: (value): value is NativeThemeDescriptor => value instanceof NativeThemeDescriptor,
  parse: nativeThemeDescriptorData,
  identity: (data) => ({ id: data.settings.id, version: data.settings.version, sourceDigest: data.source.digest }),
  receipt: ({ descriptor, operationId, revision, digest, settingsDigest, status }) => ({
    operationId,
    revision,
    sourceDigest: descriptor.source.digest,
    root: descriptor.root,
    settingsDigest,
    id: descriptor.settings.id,
    version: descriptor.settings.version,
    digest,
    status,
  }),
};
