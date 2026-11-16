import type { MetadataStore } from "../../shared/async-value.js";
import type { ChannelTemplateCatalog } from "../../shared/presentation/templates.js";
import type { VariantStore } from "./ports.js";
import { createHash } from "node:crypto";
import { templateDescriptor } from "../../shared/presentation/templates.js";
import { zip, strToU8, type Zippable } from "fflate";
import type { VariantExport } from "../../shared/publishing/variants.js";
import type { PublicationAssets } from "./content/source-port.js";
import type { PublicationFormat } from "../../shared/publishing/content.js";
import type { ContentFormatter } from "./content/formatter.js";
import type { VariantService } from "./variant-service.js";
import { renderContent, type TemplateName } from "./content/render.js";
import { contentImages, localAssetId } from "./content/walk.js";
import { PublicationError } from "./errors.js";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const documentHtml = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'"><title>Document export</title></head><body style="padding:24px">${body}</body></html>`;
function filename(title: string) {
  return (
    [...title]
      .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
      .join("")
      .replace(/[<>:"/\\|?*]/g, "-")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 100) || "document"
  );
}
/** Export reads only referenced, authorized assets; it never fetches URLs or walks source directories. */
export class VariantExporter {
  private active = 0;
  constructor(
    private variants: VariantService<VariantStore, MetadataStore<ChannelTemplateCatalog>>,
    private assets: PublicationAssets,
    private formatters: ReadonlyMap<PublicationFormat, ContentFormatter>,
  ) {}
  async export(id: string, kind: VariantExport) {
    if (this.active >= 2) throw new PublicationError("unavailable", 429);
    this.active++;
    try {
      return await this.create(id, kind);
    } finally {
      this.active--;
    }
  }
  private async create(id: string, kind: VariantExport): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
    const { detail, ir, guard } = await this.variants.capture(id),
      variant = detail.variant,
      stem = filename(variant.title);
    const formatter = this.formatters.get(variant.format);
    let template;
    try {
      template = templateDescriptor(variant.templateSnapshot || (variant.templateId as TemplateName));
    } catch {
      throw new PublicationError("staleVariant", 409);
    }
    if (
      template.id !== variant.templateId ||
      (variant.templateDigest &&
        createHash("sha256").update(JSON.stringify(template)).digest("hex") !== variant.templateDigest)
    )
      throw new PublicationError("staleVariant", 409);
    if (formatter?.version !== variant.formatterVersion || template?.version !== variant.templateVersion)
      throw new PublicationError("staleVariant", 409);
    if (kind === "text")
      return {
        bytes: strToU8(
          variant.posts.length ? variant.posts.map((post) => post.text).join("\n\n---\n\n") : variant.text,
        ),
        mime: "text/plain; charset=utf-8",
        name: `${stem}.txt`,
      };
    if (kind !== "html" && kind !== "bundle") throw new PublicationError("invalidInput");
    const references = contentImages(ir);
    const files: Zippable = {},
      urls = new Map<string, string>(),
      manifest: {
        source: string;
        path?: string;
        digest?: string;
        name?: string;
        state: "included" | "external" | "unavailable";
      }[] = [];
    const canonical = ir.origin ? JSON.stringify(ir.origin.body, null, 2) : null;
    let size = Buffer.byteLength(ir.source) * 3 + (canonical ? Buffer.byteLength(canonical) : 0);
    if (size > MAX_EXPORT_BYTES) throw new PublicationError("exportTooLarge", 413);
    for (const source of new Set(references.map((image) => image.source))) {
      const assetId = localAssetId(source);
      if (!assetId) {
        manifest.push({ source, state: "external" });
        continue;
      }
      const asset = await this.assets.content(ir.documentId, assetId, ir.projectId);
      size += asset.bytes.length;
      if (size > MAX_EXPORT_BYTES) throw new PublicationError("exportTooLarge", 413);
      const name = filename(asset.name),
        path = `assets/${assetId}/${name}`;
      if (kind === "bundle") files[path] = [asset.bytes, { level: 0 }];
      urls.set(
        source,
        kind === "bundle"
          ? path.split("/").map(encodeURIComponent).join("/")
          : `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString("base64")}`,
      );
      manifest.push({ source, path, name: asset.name, digest: asset.digest, state: "included" });
    }
    const rendered = renderContent(ir, template, (source) => urls.get(source) || null);
    const html = strToU8(documentHtml(rendered.html));
    if (html.byteLength + size > MAX_EXPORT_BYTES) throw new PublicationError("exportTooLarge", 413);
    await guard();
    if (kind === "html") return { bytes: html, mime: "text/html; charset=utf-8", name: `${stem}.html` };
    files["article.html"] = html;
    files["article.txt"] = strToU8(variant.text);
    files["source.md"] = strToU8(ir.source);
    if (canonical) files["source.rich.json"] = strToU8(canonical);
    files["manifest.json"] = strToU8(
      JSON.stringify(
        {
          schema: 1,
          variant: id,
          digest: detail.digest,
          source: variant.source,
          ...(canonical
            ? { sourceFormat: "richtext", canonicalSource: "source.rich.json", exchangeSource: "source.md" }
            : {}),
          format: variant.format,
          template: {
            id: variant.templateId,
            version: variant.templateVersion,
            digest: variant.templateDigest,
            snapshot: variant.templateSnapshot,
          },
          stale: detail.stale,
          review: detail.review,
          issues: variant.issues,
          assets: manifest,
        },
        null,
        2,
      ),
    );
    if (variant.posts.length) files["posts.json"] = strToU8(JSON.stringify(variant.posts, null, 2));
    for (const [name, value] of Object.entries(formatter.exportAttachments?.(ir) || {})) {
      if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name) || Object.hasOwn(files, name))
        throw new PublicationError("unavailable", 503);
      files[name] = strToU8(JSON.stringify(value, null, 2));
    }
    const bytes = await new Promise<Uint8Array>((resolve, reject) =>
      zip(files, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result))),
    );
    await guard();
    return { bytes, mime: "application/zip", name: `${stem}.zip` };
  }
}
