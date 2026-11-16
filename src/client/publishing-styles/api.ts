import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";
import type { ChannelTemplateDescriptor } from "../../shared/presentation/templates.js";
import type { TemplateFixturePreview } from "../../shared/plugins/library.js";
import type { PublicationFormat } from "../../shared/publishing/content.js";

export async function styleSample(template: ChannelTemplateDescriptor, format: PublicationFormat) {
  const response = await request("/api/publishing-styles/sample", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: template.id, version: template.version, format }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new PluginApiError(response.status, payload);
  return payload as TemplateFixturePreview;
}
