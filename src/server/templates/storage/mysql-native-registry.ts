import type { SQL } from "bun";
import {
  NativeThemeError,
  type NativeThemeDescriptorData,
  type NativeThemeReceipt,
} from "../../../shared/templates/native/contracts.js";
import { MySQLImmutableVersions } from "../../packages/versions/mysql.js";
import type { AsyncStore } from "../../packages/mysql-ledger.js";
import type { NativeThemeRegistry } from "../native/ports.js";
import { nativeThemeVersionPolicy } from "../native/version-policy.js";
/** Immutable source trees remain in their existing owned namespaces. */
export class MySQLNativeThemes implements AsyncStore<NativeThemeRegistry> {
  private readonly versions: MySQLImmutableVersions<NativeThemeDescriptorData, NativeThemeReceipt>;
  constructor(sql: SQL, now = Date.now) {
    this.versions = new MySQLImmutableVersions(
      sql,
      "native_theme",
      nativeThemeVersionPolicy,
      (code) => new NativeThemeError(code),
      now,
    );
  }
  async snapshot(actor: string) {
    const value = await this.versions.snapshot(actor);
    return { revision: value.revision, themes: value.versions };
  }
  detail(...args: Parameters<NativeThemeRegistry["detail"]>) {
    return this.versions.detail(...args);
  }
  source(...args: Parameters<NativeThemeRegistry["source"]>) {
    return this.versions.source(...args);
  }
  operation(...args: Parameters<NativeThemeRegistry["operation"]>) {
    return this.versions.operation(...args);
  }
  reserve(...args: Parameters<NativeThemeRegistry["reserve"]>) {
    return this.versions.reserve(...args);
  }
  commit(...args: Parameters<NativeThemeRegistry["commit"]>) {
    return this.versions.commit(...args);
  }
  fail(...args: Parameters<NativeThemeRegistry["fail"]>) {
    return this.versions.fail(...args);
  }
  cleanupDone(...args: Parameters<NativeThemeRegistry["cleanupDone"]>) {
    return this.versions.cleanupDone(...args);
  }
  recoverable() {
    return this.versions.recoverable();
  }
  referenced(...args: Parameters<NativeThemeRegistry["referenced"]>) {
    return this.versions.referenced(...args);
  }
  state(...args: Parameters<NativeThemeRegistry["state"]>) {
    return this.versions.state(...args);
  }
}
