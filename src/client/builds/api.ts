import { request } from "../http-client.js";
import type { SiteBuild, SiteBuildRequest, BuildAvailability } from "../../shared/builds/jobs.js";

export class SiteBuildApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super("Site build request failed");
  }
}
async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new SiteBuildApiError(response.status, value);
  return value as T;
}
export const siteBuildApi = {
  async nativeThemes() {
    try {
      return await json<import("../../shared/templates/native/contracts.js").NativeThemeList>("/api/templates/native");
    } catch (error) {
      if (error instanceof SiteBuildApiError && [403, 404].includes(error.status)) return { revision: 0, themes: [] };
      throw error;
    }
  },
  configuration: (id: string, project?: string) =>
    json<{
      space: import("../../shared/documents/contracts.js").DocumentSpace;
      profile: import("../../shared/sites/profile.js").SiteSourceProfile | null;
    }>(
      (project ? "/api/project-document-spaces/detail?" : "/api/document-spaces/source-profile?") +
        new URLSearchParams({ id, ...(project ? { project } : {}) }),
    ),
  themes: () =>
    json<{
      themes: import("../../shared/presentation/themes.js").SiteThemeDescriptor[];
      defaults: Record<"hexo" | "docusaurus", string>;
    }>("/api/document-themes"),
  pages: (id: string) => json<{ pages: string[] }>("/api/site-builds/pages?" + new URLSearchParams({ id })),
  async preview(id: string, path: string) {
    const response = await request(
      `/api/site-builds/preview/${encodeURIComponent(id)}/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (!response.ok) throw new SiteBuildApiError(response.status, await response.json());
    return response.text();
  },
  availability: () => json<BuildAvailability>("/api/site-builds/availability"),
  list: (space: string, project?: string) =>
    json<{ builds: SiteBuild[] }>(
      "/api/site-builds?" + new URLSearchParams({ space, ...(project ? { project } : {}) }),
    ),
  create: (value: SiteBuildRequest) => json<{ build: SiteBuild }>("/api/site-builds", "POST", value),
  detail: (id: string) =>
    json<{ build: SiteBuild; logs: string }>("/api/site-builds/detail?" + new URLSearchParams({ id })),
  cancel: (id: string) => json<{ build: SiteBuild }>("/api/site-builds/cancel", "POST", { id }),
  remove: (id: string) => json<{ ok: true }>("/api/site-builds/detail?" + new URLSearchParams({ id }), "DELETE"),
  async download(id: string) {
    const response = await request("/api/site-builds/download?" + new URLSearchParams({ id }));
    if (!response.ok) throw new SiteBuildApiError(response.status, await response.json());
    const url = URL.createObjectURL(await response.blob()),
      link = document.createElement("a");
    link.href = url;
    link.download = `site-${id}.zip`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
