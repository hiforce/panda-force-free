import type { Database } from "bun:sqlite";
import type { NativeSlidesDescriptorData, NativeSlidesInstallReceipt } from "../../../shared/slides/registry.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { SqliteImmutableVersions } from "../../packages/versions/registry.js";
import { openVersionDatabase } from "../../packages/versions/database.js";

import { nativeSlidesVersionPolicy } from "../templates/version-policy.js";
export { nativeSlidesVersionPolicy } from "../templates/version-policy.js";
export const openNativeSlidesDatabase = (path: string) =>
  openVersionDatabase(path, "native_slides", () => new NativeSlidesTemplateError("unavailable"));
export class SqliteNativeSlides extends SqliteImmutableVersions<
  NativeSlidesDescriptorData,
  NativeSlidesInstallReceipt
> {
  constructor(db: Database, now = Date.now) {
    super(db, "native_slides", nativeSlidesVersionPolicy, (code) => new NativeSlidesTemplateError(code), now);
  }
}
