import { supportedEffort } from "../engine/runtime-selection.js";

/** Creation uses the advertised model default and retains explicit choices. */
export function defaultCreationEffort(supported: readonly string[], fallback = ""): string {
  return supportedEffort(supported, "", fallback);
}
