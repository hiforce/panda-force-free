import type { OwnedPackageSources } from "../../../shared/packages/ownership.js";
import type { NativeThemeDescriptor } from "../../../shared/templates/native/descriptor.js";
import type {
  NativeThemeApproval,
  NativeThemeIntent,
  NativeThemeReceipt,
  NativeThemeSnapshot,
  InstalledNativeTheme,
  NativeThemeSourceRef,
} from "../../../shared/templates/native/contracts.js";

export interface NativeThemeRegistry {
  snapshot(actor: string): NativeThemeSnapshot;
  detail(actor: string, id: string, version: string): InstalledNativeTheme;
  source(actor: string, id: string, version: string): NativeThemeSourceRef;
  operation(actor: string, id: string): NativeThemeIntent | null;
  reserve(
    actor: string,
    signature: string,
    value: NativeThemeDescriptor,
    approval: NativeThemeApproval,
    settingsDigest: string,
  ): NativeThemeIntent;
  commit(actor: string, id: string, source: NativeThemeSourceRef): NativeThemeReceipt;
  fail(actor: string, id: string): void;
  cleanupDone(actor: string, id: string): void;
  recoverable(): NativeThemeIntent[];
  referenced(actor: string, sourceId: string): boolean;
  state(
    actor: string,
    id: string,
    version: string,
    digest: string,
    action: "enable" | "disable" | "activate",
    revision: number,
  ): InstalledNativeTheme;
}
/** Accepted source ownership is separate from template metadata and survives intake cleanup. */
export type NativeThemeSources = OwnedPackageSources;
