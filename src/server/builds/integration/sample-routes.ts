import type { Route, RouteContext } from "../../http/router.js";
import { readJsonBody } from "../../http/body.js";
import { respondJson } from "../../http/respond.js";
import { buildId } from "../../../shared/builds/validation.js";
import type { BuildInput } from "../../../shared/builds/contracts.js";
import { SiteBuildPreview, sitePreviewHeaders } from "../preview.js";
import { SiteBuildError } from "../errors.js";
import type { SiteBuildArtifacts } from "../artifacts.js";

type Maybe<T> = T | Promise<T>;
export interface SiteSampleHttpPort<Run extends { id: string; site: BuildInput["site"] }> {
  lookup(actor: string, source: unknown): Maybe<Run | null>;
  start(actor: string, value: unknown): Maybe<Run>;
  list(actor: string): Maybe<Run[]>;
  detail(actor: string, id: string): Maybe<Run>;
  logs(actor: string, id: string): Maybe<string>;
  cancel(actor: string, id: string): Maybe<Run>;
  requireArtifact(actor: string, id: string): Maybe<Run>;
  remove(actor: string, id: string): Promise<void>;
}
type Guard = (work: (context: RouteContext, actor: string) => void | Promise<void>) => Route["handler"];

/** Both sample protocols share private preview policy, bounded HTTP bodies and artifact access checks. */
export function staticSiteSampleRoutes<Run extends { id: string; site: BuildInput["site"] }>(
  prefix: string,
  service: SiteSampleHttpPort<Run>,
  artifacts: SiteBuildArtifacts,
  protect: Guard,
): Route[] {
  const preview = (actor: string) =>
    new SiteBuildPreview({ requireArtifact: async (id) => service.requireArtifact(actor, id) }, artifacts, {
      cacheDurationMs: 0,
    });
  const id = (url: URL) => {
    if ([...url.searchParams.keys()].some((key) => key !== "id") || url.searchParams.getAll("id").length !== 1)
      throw new SiteBuildError("invalidInput");
    return buildId(url.searchParams.get("id")!);
  };
  const command = async (context: RouteContext, name: string) => {
    if (context.url.search) throw new SiteBuildError("invalidInput");
    const input = await readJsonBody(context.req, 4096);
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, name)) throw new SiteBuildError("invalidInput");
    return input[name];
  };
  return [
    {
      path: prefix + "/lookup",
      method: "POST",
      handler: protect(async (context, actor) => {
        respondJson(context.res, 200, { build: await service.lookup(actor, await command(context, "source")) });
      }),
    },
    {
      path: prefix,
      method: ["GET", "POST"],
      handler: protect(async (context, actor) => {
        if (context.url.search) throw new SiteBuildError("invalidInput");
        if (context.req.method === "GET") return respondJson(context.res, 200, { builds: await service.list(actor) });
        respondJson(context.res, 202, { build: await service.start(actor, await readJsonBody(context.req, 4096)) });
      }),
    },
    {
      path: prefix + "/detail",
      method: ["GET", "DELETE"],
      handler: protect(async ({ req, res, url }, actor) => {
        const key = id(url);
        if (req.method === "GET")
          return respondJson(res, 200, {
            build: await service.detail(actor, key),
            logs: await service.logs(actor, key),
          });
        await service.remove(actor, key);
        respondJson(res, 200, { ok: true });
      }),
    },
    {
      path: prefix + "/cancel",
      method: "POST",
      handler: protect(async (context, actor) => {
        const key = await command(context, "id");
        if (typeof key !== "string") throw new SiteBuildError("invalidInput");
        respondJson(context.res, 200, { build: await service.cancel(actor, buildId(key)) });
      }),
    },
    {
      path: prefix + "/pages",
      method: "GET",
      handler: protect(async ({ res, url }, actor) =>
        respondJson(res, 200, { pages: await preview(actor).pages(id(url)) }),
      ),
    },
    {
      path: prefix + "/download",
      method: "GET",
      handler: protect(async ({ res, url }, actor) => {
        const key = id(url);
        await service.requireArtifact(actor, key);
        const bytes = await artifacts.download(key);
        await service.requireArtifact(actor, key);
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": String(bytes.length),
          "cache-control": "private, no-store",
          "content-disposition": `attachment; filename="site-sample-${key}.zip"`,
          "x-content-type-options": "nosniff",
        });
        res.end(bytes);
      }),
    },
    {
      path: (path) => path.startsWith(prefix + "/preview/"),
      method: "GET",
      handler: protect(async ({ res, url }, actor) => {
        const suffix = url.pathname.slice((prefix + "/preview/").length),
          split = suffix.indexOf("/");
        if (split < 0 || url.search) throw new SiteBuildError("invalidInput");
        let path: string;
        try {
          path = decodeURIComponent(suffix.slice(split + 1));
        } catch {
          throw new SiteBuildError("invalidInput");
        }
        const result = await preview(actor).file(buildId(suffix.slice(0, split)), path);
        res.writeHead(200, sitePreviewHeaders(result.type, result.bytes.length));
        res.end(result.bytes);
      }),
    },
  ];
}
