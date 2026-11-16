import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";
import type { SiteSampleSource, SiteSampleBuild } from "../../shared/plugins/site-samples.js";

async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request("/api/site-samples" + path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new PluginApiError(response.status, value);
  return value as T;
}
export const siteSampleApi = {
  list: () => json<{ builds: SiteSampleBuild[] }>(""),
  lookup: (source: SiteSampleSource) => json<{ build: SiteSampleBuild | null }>("/lookup", "POST", { source }),
  start: (id: string, source: SiteSampleSource) => json<{ build: SiteSampleBuild }>("", "POST", { id, source }),
  detail: (id: string) => json<{ build: SiteSampleBuild; logs: string }>("/detail?" + new URLSearchParams({ id })),
  cancel: (id: string) => json<{ build: SiteSampleBuild }>("/cancel", "POST", { id }),
  pages: (id: string) => json<{ pages: string[] }>("/pages?" + new URLSearchParams({ id })),
  async download(id: string) {
    const response = await request("/api/site-samples/download?" + new URLSearchParams({ id }));
    if (!response.ok) throw new PluginApiError(response.status, await response.json());
    return response.blob();
  },
  async preview(id: string, path: string) {
    const response = await request(
      `/api/site-samples/preview/${encodeURIComponent(id)}/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (!response.ok) throw new PluginApiError(response.status, await response.json());
    return response.text();
  },
};
