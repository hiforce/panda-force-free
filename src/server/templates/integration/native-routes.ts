import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { templateObject, templateChoice } from "../../../shared/templates/portable/validation.js";
import { NativeThemeError } from "../../../shared/templates/native/contracts.js";
import { templateManagementProtection } from "./protect.js";
import type { NativeThemeServicePort } from "../native/service.js";
import { respondBinaryDownload } from "../../http/binary-download.js";
/** Only the established principal can read original-source metadata or approve executable themes. */
export function nativeThemeRoutes(service: NativeThemeServicePort, owner: (context: RouteContext) => string): Route[] {
  const protect = templateManagementProtection(owner);
  return [
    {
      path: "/api/templates/native",
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        if (url.search) throw new NativeThemeError("invalidInput");
        const snapshot = await service.snapshot(actor);
        respondJson(res, 200, {
          revision: snapshot.revision,
          themes: snapshot.themes.map(({ descriptor, ...theme }) => ({
            ...theme,
            settings: descriptor.settings,
            source: descriptor.source,
            root: descriptor.root,
            files: descriptor.projection.files.length,
            bytes: descriptor.projection.files.reduce((sum, file) => sum + file.bytes, 0),
          })),
        });
      }),
    },
    ...["detail", "content", "export"].map((action) => ({
      path: `/api/templates/native/${action}`,
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        const params = url.searchParams;
        if (
          [...params.keys()].some(
            (key) => !["id", "version", "digest"].includes(key) || params.getAll(key).length !== 1,
          )
        )
          throw new NativeThemeError("invalidInput");
        const reference = Object.fromEntries(params);
        if (action === "export") {
          await service.export(actor, reference, (value) => respondBinaryDownload(res, value, "application/zip"));
          return;
        }
        respondJson(
          res,
          200,
          action === "detail"
            ? await service.detail(actor, reference)
            : await service.source(actor, reference, async (theme) => {
                const settings = theme.descriptor.data.settings;
                return {
                  licenseText: theme.source.tree.text(settings.license.file, 256 * 1024),
                  readmeText: settings.readme ? theme.source.tree.text(settings.readme, 512 * 1024) : "",
                };
              }),
        );
      }),
    })),
    ...["prepare", "review", "install"].map((action) => ({
      path: `/api/templates/native/${action}`,
      method: "POST",
      handler: protect(async ({ req, res }, actor) => {
        const input = await readJsonBody(req, 128 * 1024);
        respondJson(
          res,
          action === "install" ? 201 : 200,
          await (action === "install"
            ? await service.install(actor, input)
            : action === "prepare"
              ? await service.prepare(actor, input)
              : await service.review(actor, input)),
        );
      }),
    })),
    {
      path: "/api/templates/native/state",
      method: "PUT",
      handler: protect(async ({ req, res }, actor) => {
        const input = templateObject(await readJsonBody(req, 4096), ["reference", "action", "expectedRevision"]);
        respondJson(res, 200, {
          theme: await service.state(
            actor,
            input.reference,
            templateChoice(input.action, ["enable", "disable", "activate"]),
            input.expectedRevision,
          ),
          revision: (await service.snapshot(actor)).revision,
        });
      }),
    },
  ];
}
