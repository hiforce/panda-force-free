import type { CreationAvailability } from "./contracts.js";

/** Typed creation infers intent independently of transient renderer health; older APIs and uncertain requests keep their contract. */
export function defaultCreationOutput(options: Pick<CreationAvailability, "outputTypes">): "auto" | "document" {
  return options.outputTypes === undefined ? "document" : "auto";
}
