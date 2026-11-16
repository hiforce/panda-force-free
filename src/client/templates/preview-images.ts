import type { PortableTemplateModel } from "../../shared/templates/types/contracts.js";
import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";

/** Resolve authenticated native resources into inert data URLs before entering the opaque frame. */
export async function templatePreviewImages(model: PortableTemplateModel, reference: URLSearchParams) {
  const images = new Map<string, string>();
  if (model.kind !== "document" || model.syntax !== "richtext") return images;
  for (const image of model.images) {
    const query = new URLSearchParams(reference);
    query.set("image", image.id);
    const response = await request("/api/templates/images/content?" + query);
    if (!response.ok) throw new PluginApiError(response.status, await response.json());
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== image.bytes || response.headers.get("content-type") !== image.mediaType)
      throw new PluginApiError(503, { messageId: "plugins.packageUnavailable" });
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(new Blob([bytes], { type: image.mediaType }));
    });
    images.set(image.id, url);
  }
  return images;
}
