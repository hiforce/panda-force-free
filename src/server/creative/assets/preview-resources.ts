import { extname } from "node:path";
import { CREATIVE_ASSET_LIMITS as limits } from "../../../shared/creative/assets.js";
import { rewritePreviewCss } from "./preview-css.js";

export interface CreativePreviewResource {
  name: string;
  bytes: Uint8Array;
}
const origin = "https://panda-bundle.invalid",
  mime: Record<string, string> = {
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };

/** Resources are immutable caller-owned bytes, never fetchable URLs or filesystem paths. */
export class CreativePreviewResources {
  private readonly files: Map<string, Uint8Array>;
  private readonly sheets = new Map<string, string>();
  private readonly reading = new Set<string>();
  private remaining = limits.previewBytes;
  constructor(resources: readonly CreativePreviewResource[]) {
    this.files = new Map(resources.map((file) => [file.name, file.bytes]));
  }
  private use(value: string) {
    this.remaining -= Buffer.byteLength(value);
    if (this.remaining < 0) throw new RangeError("Preview resource limit");
    return value;
  }
  private path(value: string, base: string) {
    try {
      const url = new URL(value, origin + "/" + base);
      return url.origin === origin ? decodeURIComponent(url.pathname.slice(1)) : undefined;
    } catch {
      return undefined;
    }
  }
  stylesheet(value: string, base: string): string | undefined {
    const path = this.path(value, base),
      bytes = path === undefined ? undefined : this.files.get(path);
    if (path === undefined || !bytes || extname(path).toLowerCase() !== ".css") return undefined;
    const prior = this.sheets.get(path);
    if (prior !== undefined) return this.use(prior);
    if (this.reading.has(path)) return "";
    if (this.reading.size >= 8) throw new RangeError("Preview stylesheet depth");
    this.reading.add(path);
    try {
      const css = this.css(new TextDecoder("utf-8", { fatal: true }).decode(bytes), path);
      this.sheets.set(path, css);
      return this.use(css);
    } finally {
      this.reading.delete(path);
    }
  }
  image(value: string, base: string): string | undefined {
    const uri = this.url(value, base, false);
    return uri.startsWith("data:image/") ? uri : undefined;
  }
  css(value: string, base: string) {
    return rewritePreviewCss(value, (url, stylesheet) => this.url(url, base, stylesheet)).replace(/</g, "\\3c ");
  }
  private url(value: string, base: string, stylesheet: boolean): string {
    if (!stylesheet && value.startsWith("#")) return value;
    if (stylesheet) {
      const css = this.stylesheet(value, base);
      return css === undefined
        ? "data:,"
        : this.use("data:text/css;charset=utf-8;base64," + Buffer.from(css).toString("base64"));
    }
    if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(value)) return this.use(value);
    const path = this.path(value, base),
      bytes = path === undefined ? undefined : this.files.get(path),
      type = path === undefined ? undefined : mime[extname(path).toLowerCase()];
    return bytes && type ? this.use("data:" + type + ";base64," + Buffer.from(bytes).toString("base64")) : "data:,";
  }
}
