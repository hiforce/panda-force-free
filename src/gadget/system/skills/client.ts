import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import type { ClientGadgetRegistry } from "../../../client/gadget/contracts.js";
import { rowGadget } from "../row-view.js";
export function register(registry: ClientGadgetRegistry) {
  registry.register(manifest as GadgetManifest, rowGadget({ empty: "noSkills", skills: true, icon: "file" }));
}
