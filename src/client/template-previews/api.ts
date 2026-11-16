import type { TemplatePreviewJob } from "../../shared/template-previews/contracts.js";
import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";
async function call(path: string, body?: unknown): Promise<{ job: TemplatePreviewJob | null }> {
  const response = await request("/api/template-previews" + path, {
    cache: "no-store",
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new PluginApiError(response.status, value);
  return value;
}
export const templatePreviewApi = {
  lookup: (key: string, locale: string) => call("?" + new URLSearchParams({ key, locale })),
  start: (id: string, templateKey: string, locale: string) => call("", { id, templateKey, locale }),
  detail: (id: string) => call("/detail?" + new URLSearchParams({ id })),
  retry: (id: string) => call("/retry", { id }),
};
