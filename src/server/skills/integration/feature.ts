import { join } from "node:path";
import type { RouteContext } from "../../http/router.js";
import { openSkillDatabase } from "../storage/database.js";
import { SqliteSkillRegistry } from "../storage/repository.js";
import { FileSkillBundles } from "../storage/bundles.js";
import { SkillCatalog } from "../catalog/service.js";
import { seedBuiltinWriting, seedBuiltinPack } from "../builtin/seed.js";
import { builtinEssentialsPack } from "../builtin/essentials.js";
import { skillCatalogRoutes } from "./routes.js";
import { skillManagementRoutes } from "./management-routes.js";
import { RasterCoverRenderer } from "../../media/raster-cover.js";
import { skillArtwork, skillArtworkRoutes } from "./artwork.js";
import type { SkillRegistryStore } from "../ports.js";

/** Skills have their own durable catalog; initialization never touches the shared engine or user projects. */
export async function createSkillFeature(options: {
  stateRoot: string;
  version: string;
  owner(context: RouteContext): string;
  registry?: SkillRegistryStore;
}) {
  const db = options.registry ? null : openSkillDatabase(join(options.stateRoot, "data", "skills.sqlite"));
  try {
    const registry = options.registry ?? new SqliteSkillRegistry(db!),
      bundles = new FileSkillBundles(join(options.stateRoot, "plugins", "skill-packs", "bundles")),
      renderer = new RasterCoverRenderer(),
      catalog = new SkillCatalog(registry, bundles, options.version, Date.now, skillArtwork(renderer));
    await seedBuiltinWriting(registry, catalog);
    if (!(await registry.known("panda-force.essentials")))
      await seedBuiltinPack(registry, catalog, await builtinEssentialsPack());
    return {
      catalog,
      routes: [
        ...skillCatalogRoutes(catalog, options.owner),
        ...skillManagementRoutes(catalog, options.owner),
        ...skillArtworkRoutes(catalog, renderer, options.owner),
      ],
      close: () => db?.close(),
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}
