import type { Route } from "./router.js";
import { respondJson } from "./respond.js";
import type { EngineImages } from "../workspace/engine-images.js";

export function engineImageRoutes(images: EngineImages): Route[] {
  return [
    {
      path: "/api/images/engine",
      method: "GET",
      handler: async ({ url, res }) => {
        try {
          if (
            [...url.searchParams.keys()].some((key) => !["token", "thumbnail", "name"].includes(key)) ||
            url.searchParams.getAll("token").length !== 1 ||
            url.searchParams.getAll("thumbnail").length > 1
          )
            throw Error("Invalid image reference");
          const image = await images.image(url.searchParams.get("token")!, url.searchParams.get("thumbnail") === "1");
          res.writeHead(200, {
            "content-type": image.type,
            "content-length": String(image.bytes.length),
            "cache-control": "private, max-age=300",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
          });
          res.end(image.bytes);
        } catch (error) {
          respondJson(res, (error as { status?: number }).status === 503 ? 503 : 404, { error: "Image unavailable" });
        }
      },
    },
  ];
}
