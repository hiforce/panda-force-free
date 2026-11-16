import type { Route } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { documentRouteProtection as protect } from "../protection.js";
import { text, localeText, documentInput } from "../validation.js";
import type { ProjectSourceProfiles } from "./port.js";
import { DocumentError } from "../errors.js";

export function projectSourceProfileRoutes(profiles: ProjectSourceProfiles): Route[] {
  return [
    {
      path: "/api/project-document-spaces/source-profile/options",
      method: "GET",
      handler: protect(async ({ res, url }) =>
        respondJson(
          res,
          200,
          await profiles.options(text(url.searchParams.get("project"), 128), text(url.searchParams.get("id"), 128)),
        ),
      ),
    },
    {
      path: "/api/project-document-spaces/source-profile/inspect",
      method: "POST",
      handler: protect(async ({ req, res, url }) => {
        const input = documentInput(await readJsonBody(req, 8192), ["locale", "files", "webp"]);
        if (
          !Array.isArray(input.files) ||
          input.files.some((file) => typeof file !== "string") ||
          typeof input.webp !== "boolean"
        )
          throw new DocumentError("invalidInput");
        respondJson(
          res,
          200,
          await profiles.inspect(
            text(url.searchParams.get("project"), 128),
            text(url.searchParams.get("id"), 128),
            localeText(input.locale),
            input.files as string[],
            input.webp,
          ),
        );
      }),
    },
  ];
}
