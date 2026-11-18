import {
  DOCUMENT_CREATION_CAPABILITIES,
  type CreationOutputType,
  type CreationRequestedOutput,
} from "../../../shared/creation/contracts.js";
import type { SkillCapability } from "../../../shared/skills/contracts.js";

/** Capability declarations follow the tools available for this requested output, never a package category. */
export function creationCaptureCapabilities(
  output: CreationRequestedOutput | undefined,
  available: readonly CreationOutputType[],
): SkillCapability[] {
  const capabilities: SkillCapability[] = [...DOCUMENT_CREATION_CAPABILITIES];
  for (const type of available) {
    if (
      type !== "document" &&
      (output === "auto" || output === type || (type === "image" && output !== undefined && output !== "document"))
    )
      capabilities.push(`generate.${type}`);
  }
  return capabilities;
}
