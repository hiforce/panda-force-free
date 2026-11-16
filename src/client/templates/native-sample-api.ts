import type { NativeSampleBuild, NativeBuildThemeRef } from "../../shared/builds/native-samples.js";
import { templateJson } from "./api.js";
import { request } from "../http-client.js";
import { PluginApiError } from "../plugins/api.js";

const prefix = "/api/templates/native/samples";
export const nativeSampleApi = {
  lookup: (source: NativeBuildThemeRef) =>
    templateJson<{ build: NativeSampleBuild | null }>(prefix + "/lookup", "POST", { source }),
  start: (id: string, theme: NativeBuildThemeRef) =>
    templateJson<{ build: NativeSampleBuild }>(prefix, "POST", { id, theme }),
  detail: (id: string) =>
    templateJson<{ build: NativeSampleBuild; logs: string }>(prefix + "/detail?" + new URLSearchParams({ id })),
  cancel: (id: string) => templateJson<{ build: NativeSampleBuild }>(prefix + "/cancel", "POST", { id }),
  pages: (id: string) => templateJson<{ pages: string[] }>(prefix + "/pages?" + new URLSearchParams({ id })),
  async download(id: string) {
    const response = await request(prefix + "/download?" + new URLSearchParams({ id }));
    if (!response.ok) throw new PluginApiError(response.status, await response.json());
    return response.blob();
  },
  async preview(id: string, path: string) {
    const response = await request(
      prefix + `/preview/${encodeURIComponent(id)}/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (!response.ok) throw new PluginApiError(response.status, await response.json());
    return response.text();
  },
};
