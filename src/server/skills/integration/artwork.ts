import type { VerifiedSkillPack } from "../../../shared/skills/contracts.js";
import type { Route, RouteContext } from "../../http/router.js";
import { RasterCoverBusyError, RasterCoverRenderer, respondRasterCover } from "../../media/raster-cover.js";
import type { SkillCatalog } from "../catalog/service.js";
import { SkillRegistryError } from "../errors.js";
import { skillManagementProtection } from "./protect.js";

export function skillArtwork(renderer: RasterCoverRenderer) {
  return async (pack: VerifiedSkillPack) => {
    try {
      const paths = new Set(
        pack.manifest.skills.flatMap((skill) => [
          ...(skill.previews || []),
          ...(skill.cover ? [skill.cover.path] : []),
        ]),
      );
      for (const path of paths) await renderer.render(pack.read(path));
    } catch (error) {
      throw new SkillRegistryError(error instanceof RasterCoverBusyError ? "unavailable" : "invalidInput");
    }
  };
}

export function skillArtworkRoutes(
  catalog: SkillCatalog,
  renderer: RasterCoverRenderer,
  owner: (context: RouteContext) => string,
): Route[] {
  return [
    {
      path: "/api/skill-packs/cover",
      method: "GET",
      handler: skillManagementProtection(owner)(async ({ req, res, url }) => {
        const params = url.searchParams,
          keys = ["id", "version", "digest", "exportId"];
        if (
          [...params.keys()].some((key) => !keys.includes(key)) ||
          keys.some((key) => params.getAll(key).length !== 1)
        )
          throw new SkillRegistryError("invalidInput");
        const bytes = await catalog.artwork(
          params.get("id"),
          params.get("version"),
          params.get("digest"),
          params.get("exportId"),
        );
        respondRasterCover(req, res, await renderer.render(bytes));
      }),
    },
  ];
}
