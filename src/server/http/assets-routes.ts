import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { resolveSafeRegularFile } from "../path-utils.js";
import type { Route } from "./router.js";

/** Vendor assets share one path validation and cache policy. */
export function assetsRoutes({ appRoot, mime }: { appRoot: string; mime: Record<string, string> }): Route[] {
  const assets = [
    { prefix: "/vendor/katex/", directory: "katex/dist", fixed: null },
    { prefix: "/vendor/xterm/xterm.css", directory: "@xterm/xterm/css", fixed: "xterm.css" },
  ];
  return assets.map(({ prefix, directory, fixed }) => ({
    path: fixed ? prefix : (pathname: string) => pathname.startsWith(prefix),
    method: ["GET", "HEAD"],
    handler: ({ req, res, url }) => {
      let file: string | null = null;
      try {
        file = resolveSafeRegularFile(
          resolve(appRoot, "node_modules", directory),
          fixed || decodeURIComponent(url.pathname.slice(prefix.length)),
        );
      } catch {
        /* Invalid URL encodings are unavailable assets. */
      }
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": mime[extname(file)] || "application/octet-stream",
        "cache-control": "public, max-age=86400",
      });
      res.end(req.method === "HEAD" ? undefined : readFileSync(file));
    },
  }));
}
