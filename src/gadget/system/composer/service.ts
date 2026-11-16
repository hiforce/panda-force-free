import manifest from "./manifest.json";
import type { GadgetManifest } from "../../../shared/gadget/contracts.js";
import type { GadgetModule } from "../../../server/gadget/registry.js";
import type { SystemGadgetPorts } from "../ports.js";
export function composerGadget(ports: SystemGadgetPorts): GadgetModule {
  const authorize = (ctx: { owner: string }) => ports.authorize(ctx.owner, "conversations.create");
  return {
    manifest: manifest as GadgetManifest,
    services: { summary: { authorize, handle: (ctx) => ({ mode: "conversation" }) } },
  };
}
