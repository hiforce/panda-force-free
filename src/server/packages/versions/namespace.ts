import type { VersionNamespace } from "./contracts.js";
export function versionNamespace(value: VersionNamespace): string {
  if (!["native_theme", "native_slides"].includes(value)) throw new Error("Invalid registry namespace");
  return value;
}
