import { join } from "node:path";
import { registerDeploymentGadgets } from "./module-loader.js";
import { GadgetRegistry } from "./registry.js";
import { GadgetStore } from "./store.js";
import { GadgetWorkspaceService } from "./service.js";
import { gadgetRoutes } from "./routes.js";
import type { GadgetRepository } from "./ports.js";
import type { RouteContext } from "../http/router.js";
export async function createGadgetFeature(options: {
  stateRoot: string;
  owner(ctx: RouteContext): string;
  register(registry: GadgetRegistry): void;
  store?: GadgetRepository;
  modules?: readonly string[];
  upgradeLayout?: ConstructorParameters<typeof GadgetWorkspaceService>[2];
}) {
  const registry = new GadgetRegistry();
  options.register(registry);
  for (const path of options.modules ?? []) await registerDeploymentGadgets(path, registry);
  const store = options.store ?? new GadgetStore(join(options.stateRoot, "data", "gadgets.sqlite"));
  const service = new GadgetWorkspaceService(registry, store, options.upgradeLayout);
  return {
    registry,
    service,
    routes: gadgetRoutes(service, options.owner),
    close: async () => {
      try {
        await registry.close();
      } finally {
        await store.close();
      }
    },
  };
}
