import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import type { GadgetModule } from "../../../server/gadget/registry.js";
/** Task operations retain their existing authenticated owner and project authorization. */
export function creationsGadget(): GadgetModule {
  return { manifest: manifest as GadgetManifest, services: {} };
}
