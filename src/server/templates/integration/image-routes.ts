import type { Route, RouteContext } from "../../http/router.js";
import { respondJson } from "../../http/respond.js";
import { readRequestBytes } from "../../request-bytes.js";
import { templateManagementProtection } from "./protect.js";
import { PortableRegistryError } from "../portable/errors.js";
import type { TemplateDraftImages } from "../authoring/images.js";
import type { TemplateDraftAuthoringPort } from "../authoring/service.js";
import type { PortableTemplateInspectionPort } from "../portable/inspection.js";
import type { TemplateImageContent, TemplateImageDecoder } from "../authoring/ports.js";
import { TEMPLATE_IMAGE_BYTES } from "../../../shared/templates/authoring/images.js";
export function templateImageRoutes(
  drafts: TemplateDraftAuthoringPort,
  images: TemplateDraftImages,
  inspection: PortableTemplateInspectionPort,
  decoder: TemplateImageDecoder,
  owner: (context: RouteContext) => string,
): Route[] {
  const protect = templateManagementProtection(owner);
  const query = (context: RouteContext, keys: readonly string[]) => {
    const params = context.url.searchParams;
    if ([...params.keys()].some((key) => !keys.includes(key)) || keys.some((key) => params.getAll(key).length !== 1))
      throw new PortableRegistryError("invalidInput");
    return params;
  };
  const respond = async (context: RouteContext, value: TemplateImageContent) => {
    const decoded = await decoder.decode(value.bytes),
      image = value.image;
    if (
      decoded.image.sha256 !== image.sha256 ||
      decoded.image.mediaType !== image.mediaType ||
      decoded.image.width !== image.width ||
      decoded.image.height !== image.height ||
      decoded.bytes.length !== image.bytes
    )
      throw new PortableRegistryError("invalidInput");
    context.res.writeHead(200, {
      "content-type": image.mediaType,
      "content-length": String(value.bytes.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    });
    context.res.end(value.bytes);
  };
  return [
    {
      path: "/api/template-drafts/images",
      method: "POST",
      handler: protect(async (context, actor) => {
        const params = query(context, ["draft"]);
        const image = await images.upload(
          actor,
          params.get("draft")!,
          await readRequestBytes(context.req, TEMPLATE_IMAGE_BYTES),
        );
        respondJson(context.res, 201, { image });
      }),
    },
    {
      path: "/api/template-drafts/images/content",
      method: "GET",
      handler: protect(async (context, actor) => {
        const params = query(context, ["draft", "id"]);
        await respond(context, await drafts.image(actor, params.get("draft")!, params.get("id")!));
      }),
    },
    {
      path: "/api/templates/images/content",
      method: "GET",
      handler: protect(async (context) => {
        const params = query(context, ["id", "version", "digest", "image"]);
        await respond(
          context,
          await inspection.image(
            params.get("id")!,
            params.get("version")!,
            params.get("digest")!,
            params.get("image")!,
          ),
        );
      }),
    },
  ];
}
