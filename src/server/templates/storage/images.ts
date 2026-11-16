import type { Database } from "bun:sqlite";
import type { TemplateImage } from "../../../shared/templates/authoring/images.js";
import {
  templateImages,
  TEMPLATE_IMAGES_BYTES,
  TEMPLATE_IMAGE_BYTES,
} from "../../../shared/templates/authoring/images.js";
import { contentSha256 } from "../../../shared/packages/digest.js";
import { stableJson } from "../../../shared/stable-json.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { PortableRegistryError } from "../portable/errors.js";
import type { TemplateImageContent, TemplateImageFiles, TemplateImageStore } from "../authoring/ports.js";

export class SqliteTemplateImages implements TemplateImageStore {
  constructor(private db: Database) {}
  bind(actor: string, draft: string, image: TemplateImage) {
    this.db
      .transaction(() => {
        this.require(actor, draft);
        const prior = this.db
          .query<{ metadata: string }, [string, string]>(
            "SELECT metadata FROM portable_template_draft_images WHERE draft=? AND id=?",
          )
          .get(draft, image.id);
        if (prior) {
          if (prior.metadata !== stableJson(image)) throw new PortableRegistryError("invalidInput");
          return;
        }
        const quota = this.db
          .query<{ count: number; bytes: number }, [string]>(
            "SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM portable_template_draft_images WHERE draft=?",
          )
          .get(draft)!;
        if (quota.count >= 64 || quota.bytes + image.bytes > TEMPLATE_IMAGES_BYTES)
          throw new PortableRegistryError("invalidInput");
        this.db
          .query("INSERT INTO portable_template_draft_images(draft,id,bytes,metadata) VALUES(?,?,?,?)")
          .run(draft, image.id, image.bytes, stableJson(image));
      })
      .immediate();
  }
  get(actor: string, draft: string, id: string): TemplateImage {
    this.require(actor, draft);
    const row = this.db
      .query<{ metadata: string }, [string, string]>(
        "SELECT metadata FROM portable_template_draft_images WHERE draft=? AND id=?",
      )
      .get(draft, id);
    if (!row) throw new PortableRegistryError("draftNotFound");
    return templateImages([JSON.parse(row.metadata)])[0]!;
  }
  private require(actor: string, draft: string) {
    if (
      !this.db.query("SELECT id FROM portable_template_drafts WHERE id=? AND owner=? AND removed=0").get(draft, actor)
    )
      throw new PortableRegistryError("draftNotFound");
  }
}

/** Resource bytes stay in immutable files; the database retains only scoped bindings and quotas. */
export class FileTemplateImages implements TemplateImageFiles {
  private files: FilePackageContent<TemplateImageContent>;
  constructor(root: string) {
    this.files = new FilePackageContent(root, {
      maxBytes: Math.ceil((TEMPLATE_IMAGE_BYTES * 4) / 3) + 4096,
      digest: (value) => value.image.sha256,
      encode: async (value) =>
        new TextEncoder().encode(
          JSON.stringify({ image: value.image, base64: Buffer.from(value.bytes).toString("base64") }),
        ),
      decode: async (bytes) => {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          image = templateImages([value.image])[0]!;
        if (typeof value.base64 !== "string") throw new PortableRegistryError("unavailable");
        const binary = Buffer.from(value.base64, "base64");
        if (
          binary.length !== image.bytes ||
          binary.toString("base64") !== value.base64 ||
          (await contentSha256(binary)) !== image.sha256
        )
          throw new PortableRegistryError("unavailable");
        return { image, bytes: binary };
      },
    });
  }
  async put(value: TemplateImageContent) {
    try {
      await this.files.put(value);
    } catch {
      throw new PortableRegistryError("unavailable");
    }
  }
  async read(image: TemplateImage) {
    try {
      const value = await this.files.read(image.sha256);
      if (stableJson(value.image) !== stableJson(image)) throw new PortableRegistryError("unavailable");
      return value.bytes;
    } catch {
      throw new PortableRegistryError("unavailable");
    }
  }
}
