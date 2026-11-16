import { join } from "node:path";
import type { RouteContext } from "../http/router.js";
import type { TemplateCatalog } from "../templates/catalog.js";
import { SkillWorkspaceStore } from "./store.js";
import { SkillWorkspaceService, configuredCollection } from "./service.js";
import { skillWorkspaceRoutes } from "./routes.js";
import type { SkillWorkspaceRepository } from "./ports.js";

export function createSkillWorkspaceFeature(options: {
  stateRoot: string;
  owner(context: RouteContext): string;
  store?: SkillWorkspaceRepository;
}) {
  const store = options.store ?? new SkillWorkspaceStore(join(options.stateRoot, "data", "skill-workspace.sqlite"));
  return {
    collection: async (actor: string, id: string) => configuredCollection(await store.read(actor), id),
    routes: (catalog: TemplateCatalog) =>
      skillWorkspaceRoutes(new SkillWorkspaceService(store, catalog), options.owner),
    close: () => store.close(),
  };
}
