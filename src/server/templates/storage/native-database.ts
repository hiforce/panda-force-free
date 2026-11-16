import { NativeThemeError } from "../../../shared/templates/native/contracts.js";
import { openVersionDatabase } from "../../packages/versions/database.js";

/** Site-theme metadata uses the existing version-one namespace without migrations or body changes. */
export function openNativeThemeDatabase(path: string) {
  return openVersionDatabase(path, "native_theme", () => new NativeThemeError("unavailable"));
}
