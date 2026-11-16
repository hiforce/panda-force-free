import type { SQL } from "bun";
import { MySQLLedger, type AsyncStore } from "../../packages/mysql-ledger.js";
import type { TemplateImage } from "../../../shared/templates/authoring/images.js";
import { templateImages, TEMPLATE_IMAGES_BYTES } from "../../../shared/templates/authoring/images.js";
import { stableJson } from "../../../shared/stable-json.js";
import { PortableRegistryError } from "../portable/errors.js";
import type { TemplateImageStore } from "../authoring/ports.js";
export class MySQLPortableImages extends MySQLLedger implements AsyncStore<TemplateImageStore> {
  constructor(pool: SQL) {
    super(pool, "panda_force_portable_templates_guard", ["bytes", "total", "count", "removed"]);
  }
  async bind(actor: string, draft: string, image: TemplateImage) {
    return this.transaction(async () => {
      await this.require(actor, draft);
      const prior = await this.query<
        {
          metadata: string;
        },
        [string, string]
      >("SELECT metadata FROM panda_force_portable_template_draft_images WHERE draft=? AND id=?").get(draft, image.id);
      if (prior) {
        if (prior.metadata !== stableJson(image)) throw new PortableRegistryError("invalidInput");
        return;
      }
      const quota = (await this.query<
        {
          count: number;
          bytes: number;
        },
        [string]
      >(
        "SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM panda_force_portable_template_draft_images WHERE draft=?",
      ).get(draft))!;
      if (quota.count >= 64 || quota.bytes + image.bytes > TEMPLATE_IMAGES_BYTES)
        throw new PortableRegistryError("invalidInput");
      await this.query(
        "INSERT INTO panda_force_portable_template_draft_images(draft,id,bytes,metadata) VALUES(?,?,?,?)",
      ).run(draft, image.id, image.bytes, stableJson(image));
    });
  }
  async get(actor: string, draft: string, id: string): Promise<TemplateImage> {
    return this.readSnapshot(async () => {
      await this.require(actor, draft);
      const row = await this.query<
        {
          metadata: string;
        },
        [string, string]
      >("SELECT metadata FROM panda_force_portable_template_draft_images WHERE draft=? AND id=?").get(draft, id);
      if (!row) throw new PortableRegistryError("draftNotFound");
      return templateImages([JSON.parse(row.metadata)])[0]!;
    });
  }
  private async require(actor: string, draft: string) {
    if (
      !(await this.query(
        "SELECT id FROM panda_force_portable_template_drafts WHERE id=? AND owner=? AND removed=0",
      ).get(draft, actor))
    )
      throw new PortableRegistryError("draftNotFound");
  }
}
