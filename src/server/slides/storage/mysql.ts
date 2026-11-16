import type { SQL } from "bun";
import type { NativeSlidesDescriptorData, NativeSlidesInstallReceipt } from "../../../shared/slides/registry.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { MySQLImmutableVersions } from "../../packages/versions/mysql.js";
import { nativeSlidesVersionPolicy } from "../templates/version-policy.js";
export class MySQLNativeSlides extends MySQLImmutableVersions<NativeSlidesDescriptorData, NativeSlidesInstallReceipt> {
  constructor(sql: SQL, now = Date.now) {
    super(sql, "native_slides", nativeSlidesVersionPolicy, (code) => new NativeSlidesTemplateError(code), now);
  }
}
