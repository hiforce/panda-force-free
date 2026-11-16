import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import type { ClientGadgetRegistry } from "../../../client/gadget/contracts.js";
import type { CreationActivityCapability } from "../bindings.js";
import { CreationActivity } from "../../../client/creation/activity.js";

export function register(registry: ClientGadgetRegistry) {
  registry.register(manifest as GadgetManifest, {
    mount(host, context) {
      const access = context.capability<CreationActivityCapability>("panda.creations"),
        activity = new CreationActivity(host, context.t, access.identity, access.projects, access.navigate, {
          limit: Number(context.instance.config.limit),
        });
      try {
        activity.show();
      } catch (error) {
        activity.dispose();
        throw error;
      }
      return { update: () => activity.show(), dispose: () => activity.dispose() };
    },
  });
}
