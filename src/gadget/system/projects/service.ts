import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import { GadgetError } from "../../../shared/gadget/contracts.js";
import type { GadgetModule } from "../../../server/gadget/registry.js";
import type { SystemGadgetPorts } from "../ports.js";
export function projectsGadget(ports: SystemGadgetPorts): GadgetModule {
  const authorize = (ctx: { owner: string }) => ports.authorize(ctx.owner, "projects.read");
  return {
    manifest: manifest as GadgetManifest,
    services: { summary: { authorize, handle: (ctx) => ports.projects(ctx.owner, Number(ctx.config.limit)) } },
    actions: {
      open: {
        authorize,
        handle: (_ctx, input) => {
          const id = typeof input === "object" && input !== null && "id" in input ? String(input.id) : "";
          if (id.length > 200) throw new GadgetError("invalidInput");
          return { navigate: "/project?id=" + encodeURIComponent(id) };
        },
      },
    },
  };
}
