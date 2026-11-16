import { extname, posix } from "node:path";
import type { BuildArtifact, BuildInput } from "../../shared/builds/contracts.js";
import type { SiteBuildArtifacts } from "./artifacts.js";
import { SiteBuildError } from "./errors.js";
import { escapeHtml } from "../../shared/html.js";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
export const previewPolicy =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox; frame-ancestors 'self'";

export interface SitePreviewSource {
  requireArtifact(id: string): Promise<{ site: BuildInput["site"] }>;
}
export const sitePreviewHeaders = (type: string, length: number) => ({
  "content-type": type,
  "content-length": String(length),
  "cache-control": "private, no-store",
  "content-security-policy": previewPolicy,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

/** Static inspection uses an opaque sandbox and no scripts; full executable output is a download. */
export class SiteBuildPreview {
  private cached: { id: string; value: Promise<BuildArtifact>; expires: number } | null = null;
  private readonly cacheDurationMs: number;
  constructor(
    private service: SitePreviewSource,
    private artifacts: SiteBuildArtifacts,
    options: { cacheDurationMs?: number } = {},
  ) {
    this.cacheDurationMs = options.cacheDurationMs ?? 30_000;
  }
  private async artifact(id: string) {
    await this.service.requireArtifact(id);
    if (this.cacheDurationMs <= 0) {
      const value = await this.artifacts.read(id);
      await this.service.requireArtifact(id);
      return value;
    }
    if (!this.cached || this.cached.id !== id || this.cached.expires < Date.now()) {
      const entry = { id, value: this.artifacts.read(id), expires: Date.now() + this.cacheDurationMs };
      this.cached = entry;
      entry.value.catch(() => {
        if (this.cached === entry) this.cached = null;
      });
      setTimeout(() => {
        if (this.cached === entry) this.cached = null;
      }, this.cacheDurationMs).unref();
    }
    const value = await this.cached.value;
    await this.service.requireArtifact(id);
    return value;
  }
  async pages(id: string) {
    return (await this.manifest(id)).filter((file) => file.path.endsWith(".html")).map((file) => file.path);
  }
  async manifest(id: string) {
    return (await this.artifact(id)).files.map(({ path, sha256 }) => ({ path, sha256 }));
  }
  async file(id: string, requested: string) {
    const job = await this.service.requireArtifact(id),
      artifact = await this.artifact(id),
      files = new Map(artifact.files.map((file) => [file.path, file]));
    const resolvePath = (path: string) => {
      const candidate = path.replace(/^\/+/, "");
      return files.has(candidate)
        ? candidate
        : files.has(posix.join(candidate, "index.html"))
          ? posix.join(candidate, "index.html")
          : null;
    };
    const path = resolvePath(requested),
      type = path && mime[extname(path).toLowerCase()];
    if (!path || !type) throw new SiteBuildError("artifactUnavailable", 404);
    const site = new URL(job.site.url),
      current = new URL(job.site.basePath + path, site);
    let embeddedBytes = 0;
    const locate = (value: string, base = current) => {
      try {
        const url = new URL(value, base);
        if (url.origin !== site.origin || !url.pathname.startsWith(job.site.basePath)) return null;
        const destination = resolvePath(decodeURIComponent(url.pathname.slice(job.site.basePath.length)));
        return destination && mime[extname(destination).toLowerCase()] ? destination : null;
      } catch {
        return null;
      }
    };
    const inline = (value: string, base = current): string | null => {
      if (/^data:(?:image\/(?:png|jpeg|webp|gif)|font\/(?:woff2?|ttf));base64,/i.test(value)) {
        embeddedBytes += value.length;
        if (embeddedBytes > 16 * 1024 * 1024) throw new SiteBuildError("previewTooLarge", 413);
        return value;
      }
      const destination = locate(value, base);
      if (!destination) return null;
      const type = mime[extname(destination).toLowerCase()]!;
      if (!/^(?:image|font)\//.test(type)) return null;
      const data = files.get(destination)!.data;
      embeddedBytes += data.length;
      if (embeddedBytes > 16 * 1024 * 1024) throw new SiteBuildError("previewTooLarge", 413);
      return `data:${type};base64,${data}`;
    };
    const css = (text: string, base: URL) =>
      text
        .replace(
          /url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi,
          (_match, _quote: string, value: string) => `url(${JSON.stringify(inline(value, base) || "data:,")})`,
        )
        .replace(/@import\s[^;]+;/gi, "");
    const data = Buffer.from(files.get(path)!.data, "base64");
    if (type.startsWith("text/css")) return { type, bytes: Buffer.from(css(data.toString("utf8"), current)) };
    if (!type.startsWith("text/html")) return { type, bytes: data };
    const html = await new HTMLRewriter()
      .on("script,iframe,object,embed,base", {
        element: (element) => {
          element.remove();
        },
      })
      .on("meta[http-equiv]", {
        element: (element) => {
          element.remove();
        },
      })
      .on("link", {
        element(element) {
          const destination = locate(element.getAttribute("href") || "");
          if (element.getAttribute("rel") === "stylesheet" && destination?.endsWith(".css")) {
            const value = css(
              Buffer.from(files.get(destination)!.data, "base64").toString("utf8"),
              new URL(job.site.basePath + destination, site),
            );
            embeddedBytes += Buffer.byteLength(value);
            if (embeddedBytes > 16 * 1024 * 1024) throw new SiteBuildError("previewTooLarge", 413);
            element.replace("<style>" + value.replace(/<\/style/gi, "<\\/style") + "</style>", { html: true });
          } else element.remove();
        },
      })
      .on("*", {
        element(element) {
          for (const [attribute] of [...element.attributes])
            if (
              /^on/i.test(attribute) ||
              ["srcset", "action", "formaction", "target", "ping", "download"].includes(attribute)
            )
              element.removeAttribute(attribute);
          for (const name of ["src", "poster"]) {
            const value = element.getAttribute(name);
            if (value === null) continue;
            const replaced = inline(value);
            if (replaced) element.setAttribute(name, replaced);
            else element.removeAttribute(name);
          }
          const href = element.getAttribute("href");
          if (href !== null && !href.startsWith("#")) element.removeAttribute("href");
          element.removeAttribute("xlink:href");
        },
      })
      .transform(new Response(data, { headers: { "content-type": type } }))
      .text();
    const policy = previewPolicy.replace("; sandbox; frame-ancestors 'self'", "");
    const complete = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">` + html;
    if (Buffer.byteLength(complete) > 20 * 1024 * 1024) throw new SiteBuildError("previewTooLarge", 413);
    return { type, bytes: Buffer.from(complete) };
  }
}
