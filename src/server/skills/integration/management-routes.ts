import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import type { SkillCatalog } from "../catalog/service.js";
import { record } from "../../../shared/skills/manifest/primitives.js";
import { SKILL_BUNDLE_BYTES } from "../../../shared/skills/contracts.js";
import { encodeSkillBundle } from "../storage/codec.js";
import { readSkillUpload } from "./upload.js";
import { skillManagementProtection } from "./protect.js";

export function skillManagementRoutes(catalog: SkillCatalog, owner: (context: RouteContext) => string): Route[] {
  const protect = skillManagementProtection(owner);
  return [
    {
      path: "/api/skill-packs/detail",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(res, 200, await catalog.detail(url.searchParams.get("id"), url.searchParams.get("version"))),
      ),
    },
    {
      path: "/api/skill-packs/export",
      method: "GET",
      handler: protect(async ({ res, url }) => {
        const pack = await catalog.export(url.searchParams.get("id"), url.searchParams.get("version"));
        respondJson(res, 200, JSON.parse(new TextDecoder().decode(encodeSkillBundle(pack))));
      }),
    },
    {
      path: "/api/skill-packs/template",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(
          res,
          200,
          await catalog.template(
            url.searchParams.get("id"),
            url.searchParams.get("version"),
            url.searchParams.get("exportId"),
          ),
        ),
      ),
    },
    {
      path: "/api/skill-packs/review",
      method: "POST",
      handler: protect(async ({ req, res }) => {
        const input = record(await readJsonBody(req, 2 * SKILL_BUNDLE_BYTES + 4096), ["content", "name", "selected"]);
        const { pack, origin } = await readSkillUpload(input.content, input.name);
        respondJson(
          res,
          200,
          await catalog.review(
            pack,
            origin,
            input.selected === undefined ? pack.manifest.skills.map((item) => item.id) : input.selected,
          ),
        );
      }),
    },
    {
      path: "/api/skill-packs/install",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = record(await readJsonBody(req, 2 * SKILL_BUNDLE_BYTES + 8192), ["content", "name", "approval"]);
        const { pack, origin } = await readSkillUpload(input.content, input.name);
        const installed = await catalog.install(pack, origin, input.approval, actor);
        respondJson(res, 201, await catalog.detail(installed.id, installed.version));
      }),
    },
    {
      path: "/api/skill-packs/exports",
      method: "PUT",
      handler: protect(async ({ req, res }, actor) => {
        const installed = await catalog.setExports(await readJsonBody(req, 16384), actor);
        respondJson(res, 200, await catalog.detail(installed.id, installed.version));
      }),
    },
    {
      path: "/api/skill-packs/activate",
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const installed = await catalog.activate(await readJsonBody(req, 4096), actor);
        respondJson(res, 200, await catalog.detail(installed.id, installed.version));
      }),
    },
  ];
}
