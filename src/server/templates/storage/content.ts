import { FilePackageContent, PackageContentError } from "../../packages/content-store.js";
import type { VerifiedPortableTemplate } from "../../../shared/templates/portable/contracts.js";
import {
  exportPortableTemplates,
  parsePortableTemplateBundle,
  PORTABLE_TEMPLATE_JSON_BYTES,
} from "../../../shared/templates/portable/bundle.js";
import { PortableRegistryError } from "../portable/errors.js";
import type { PortableTemplateContent } from "../portable/ports.js";

export class FilePortableTemplates implements PortableTemplateContent {
  private files: FilePackageContent<VerifiedPortableTemplate>;
  constructor(root: string) {
    this.files = new FilePackageContent(root, {
      maxBytes: PORTABLE_TEMPLATE_JSON_BYTES,
      encode: async (value) => exportPortableTemplates([value]),
      async decode(bytes) {
        const value = await parsePortableTemplateBundle(bytes);
        if (value.templates.length !== 1) throw new PackageContentError("contentUnavailable");
        return value.templates[0]!;
      },
      digest: (value) => value.digest,
    });
  }
  async put(value: VerifiedPortableTemplate) {
    try {
      await this.files.put(value);
    } catch {
      throw new PortableRegistryError("unavailable");
    }
  }
  async read(digest: string) {
    try {
      return await this.files.read(digest);
    } catch {
      throw new PortableRegistryError("unavailable");
    }
  }
}
