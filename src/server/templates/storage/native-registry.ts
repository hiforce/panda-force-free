import type { Database } from "bun:sqlite";
import {
  NativeThemeError,
  type NativeThemeApproval,
  type NativeThemeReceipt,
  type NativeThemeDescriptorData,
  type NativeThemeSourceRef,
} from "../../../shared/templates/native/contracts.js";
import { NativeThemeDescriptor } from "../../../shared/templates/native/descriptor.js";
import { SqliteImmutableVersions } from "../../packages/versions/registry.js";
import type { NativeThemeRegistry } from "../native/ports.js";

import { nativeThemeVersionPolicy } from "../native/version-policy.js";
export { nativeThemeVersionPolicy } from "../native/version-policy.js";

/** Site semantics stay in this adapter; the common ledger preserves its existing schema and receipt representation. */
export class SqliteNativeThemes implements NativeThemeRegistry {
  private versions: SqliteImmutableVersions<NativeThemeDescriptorData, NativeThemeReceipt>;
  constructor(db: Database, now = Date.now) {
    this.versions = new SqliteImmutableVersions(
      db,
      "native_theme",
      nativeThemeVersionPolicy,
      (code) => new NativeThemeError(code),
      now,
    );
  }
  snapshot(actor: string) {
    const value = this.versions.snapshot(actor);
    return { revision: value.revision, themes: value.versions };
  }
  detail(actor: string, id: string, version: string) {
    return this.versions.detail(actor, id, version);
  }
  source(actor: string, id: string, version: string) {
    return this.versions.source(actor, id, version);
  }
  operation(actor: string, id: string) {
    return this.versions.operation(actor, id);
  }
  reserve(
    actor: string,
    signature: string,
    value: NativeThemeDescriptor,
    approval: NativeThemeApproval,
    settingsDigest: string,
  ) {
    return this.versions.reserve(actor, signature, value, approval, settingsDigest);
  }
  commit(actor: string, id: string, source: NativeThemeSourceRef) {
    return this.versions.commit(actor, id, source);
  }
  fail(actor: string, id: string) {
    this.versions.fail(actor, id);
  }
  cleanupDone(actor: string, id: string) {
    this.versions.cleanupDone(actor, id);
  }
  recoverable() {
    return this.versions.recoverable();
  }
  referenced(actor: string, sourceId: string) {
    return this.versions.referenced(actor, sourceId);
  }
  state(
    actor: string,
    id: string,
    version: string,
    digest: string,
    action: "enable" | "disable" | "activate",
    revision: number,
  ) {
    return this.versions.state(actor, id, version, digest, action, revision);
  }
}
