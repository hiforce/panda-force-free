import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { respondBinaryDownload } from "../../http/binary-download.js";
import { templateObject, templateChoice } from "../../../shared/templates/portable/validation.js";
import { NativeSlidesTemplateError } from "../../../shared/slides/templates.js";
import { templateManagementProtection } from "./protect.js";
import type { NativeSlidesServicePort } from "../../slides/templates/service.js";
function reference(url: URL) {
  if (
    [...url.searchParams.keys()].some(
      (key) => !["id", "version", "digest"].includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    throw new NativeSlidesTemplateError("invalidInput");
  return Object.fromEntries(url.searchParams);
}
/** Every read and write establishes the actor; discovery and imported bundle metadata grant no authority. */
export function nativeSlidesRoutes(
  service: NativeSlidesServicePort,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = templateManagementProtection(owner);
  return [
    {
      path: "/api/templates/native-slides",
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        if (url.search) throw new NativeSlidesTemplateError("invalidInput");
        respondJson(res, 200, await service.snapshot(actor));
      }),
    },
    ...["detail", "content", "original", "export"].map((action) => ({
      path: `/api/templates/native-slides/${action}`,
      method: "GET",
      handler: protect(async ({ url, res }, actor) => {
        const ref = reference(url);
        if (action === "detail") return respondJson(res, 200, await service.detail(actor, ref));
        await service.with(actor, ref, async (template) => {
          if (action === "content")
            return respondJson(res, 200, {
              original: template.presentation.index,
              mapping: template.mapping,
              licenseText: template.files.text("LICENSE", 256 * 1024),
              readmeText: template.files.text("README.md", 512 * 1024),
            });
          if (action === "export") return respondBinaryDownload(res, await template.export(), "application/zip");
          return respondBinaryDownload(
            res,
            {
              filename: `${template.manifest.settings.id}-${template.manifest.settings.version}.${template.presentation.index.kind}`,
              bytes: template.original(),
            },
            template.presentation.index.kind === "potx"
              ? "application/vnd.openxmlformats-officedocument.presentationml.template"
              : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          );
        });
      }),
    })),
    ...["prepare", "part", "review", "install"].map((action) => ({
      path: `/api/templates/native-slides/${action}`,
      method: "POST",
      handler: protect(async ({ req, url, res }, actor) => {
        if (url.search) throw new NativeSlidesTemplateError("invalidInput");
        const input = await readJsonBody(req, action === "prepare" || action === "part" ? 8192 : 8 * 1024 * 1024);
        const value =
          action === "prepare"
            ? await service.prepare(actor, input)
            : action === "part"
              ? await service.part(actor, input)
              : action === "review"
                ? await service.review(actor, input)
                : await service.install(actor, input);
        respondJson(res, action === "install" ? 201 : 200, value);
      }),
    })),
    {
      path: "/api/templates/native-slides/state",
      method: "PUT",
      handler: protect(async ({ req, url, res }, actor) => {
        if (url.search) throw new NativeSlidesTemplateError("invalidInput");
        const input = templateObject(await readJsonBody(req, 4096), ["reference", "action", "expectedRevision"]);
        respondJson(res, 200, {
          template: await service.state(
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
