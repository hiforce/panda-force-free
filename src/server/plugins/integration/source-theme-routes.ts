import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { validatePluginManifest } from "../../../shared/plugins/manifest.js";
import { packageRecord, packageText } from "../../../shared/plugins/validation.js";
import { pluginRouteProtection } from "./protect.js";
import { documentThemePackager, type DocumentThemeSources } from "./source-theme.js";

/** Packaging produces reviewable bytes; installation remains a separate digest-bound administrator decision. */
export function sourceThemeRoutes(documents: DocumentThemeSources, owner: (context: RouteContext) => string): Route[] {
  const protect = pluginRouteProtection(owner),
    packageTheme = documentThemePackager(documents);
  return [
    {
      path: "/api/document-packages/from-source",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const input = packageRecord(await readJsonBody(req, 64 * 1024), ["spaceId", "theme", "manifest"]);
        const result = await packageTheme(
          packageText(input.spaceId, 128),
          packageText(input.theme, 80),
          validatePluginManifest(input.manifest),
        );
        respondJson(res, 200, result);
      }),
    },
  ];
}
