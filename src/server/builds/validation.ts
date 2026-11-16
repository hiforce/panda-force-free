import { buildId, buildInput, BuildError } from "../../shared/builds/validation.js";
import type { SiteBuildRequest } from "../../shared/builds/jobs.js";
import { SiteBuildError } from "./errors.js";
import { nativeBuildThemeRef } from "./native/commands.js";

export function siteBuildRequest(value: unknown): SiteBuildRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SiteBuildError("invalidInput");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "spaceId",
          "projectId",
          "engine",
          "locale",
          "title",
          "url",
          "basePath",
          "spaceVersion",
          "nativeTheme",
        ].includes(key),
    )
  )
    throw new SiteBuildError("invalidInput");
  try {
    const id = buildId(String(input.id)),
      spaceId = buildId(String(input.spaceId));
    if (
      input.projectId !== undefined &&
      (typeof input.projectId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.projectId))
    )
      throw new SiteBuildError("invalidInput");
    const normalized = buildInput({
      protocol: 1,
      engine: input.engine,
      preset: input.engine === "hexo" ? "reader" : "handbook",
      site: { title: input.title, url: input.url, basePath: input.basePath, locale: input.locale },
      documents: [{ id: "validation", path: "index.md", title: "", content: "" }],
      assets: [],
    });
    if (!normalized.site.title.trim()) throw new SiteBuildError("invalidInput");
    if (
      input.spaceVersion !== undefined &&
      (!Number.isSafeInteger(input.spaceVersion) || Number(input.spaceVersion) < 1)
    )
      throw new SiteBuildError("invalidInput");
    return {
      id,
      spaceId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId as string }),
      engine: normalized.engine,
      ...normalized.site,
      ...(input.spaceVersion === undefined ? {} : { spaceVersion: input.spaceVersion as number }),
      ...(input.nativeTheme === undefined ? {} : { nativeTheme: nativeBuildThemeRef(input.nativeTheme) }),
    };
  } catch (error) {
    if (error instanceof BuildError) throw new SiteBuildError("invalidInput");
    throw error;
  }
}
