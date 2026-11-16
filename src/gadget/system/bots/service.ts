import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import { GadgetError } from "../../../shared/gadget/contracts.js";
import type { GadgetModule } from "../../../server/gadget/registry.js";
import type { SystemGadgetPorts } from "../ports.js";
export function botsGadget(ports: SystemGadgetPorts): GadgetModule {
  const authorize = (ctx: { owner: string }) => ports.authorize(ctx.owner, "bots.read");
  return {
    manifest: manifest as GadgetManifest,
    services: { summary: { authorize, handle: (ctx) => ports.bots(ctx.owner) } },
    actions: {
      open: {
        authorize,
        handle: (_ctx, input) => {
          const id = typeof input === "object" && input !== null && "id" in input ? String(input.id) : "";
          if (id.length > 200) throw new GadgetError("invalidInput");
          return { navigate: "/bots" };
        },
      },
    },
  };
}
