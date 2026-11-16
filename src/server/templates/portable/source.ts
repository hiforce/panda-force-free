import { contentSha256 } from "../../../shared/packages/digest.js";
import {
  parsePortableTemplateBundle,
  PORTABLE_TEMPLATE_JSON_BYTES,
} from "../../../shared/templates/portable/bundle.js";
import type { VerifiedTemplateLibrary } from "../../../shared/templates/portable/contracts.js";
import type { PortableTemplateOrigin } from "../../../shared/templates/portable/registry.js";
import { PortableRegistryError } from "./errors.js";
import { portableTemplateOrigin } from "../../../shared/templates/portable/origin.js";
import { exportPortableTemplates } from "../../../shared/templates/portable/bundle.js";
import type { VerifiedPortableTemplate } from "../../../shared/templates/portable/contracts.js";
import type { TemplateDraftRecord } from "../../../shared/templates/authoring/contracts.js";
import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { capturedTemplateLibrary } from "../sources/library.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";

/** Source provenance is established by acquisition, never by uploaded metadata. */
export class PortableTemplateSource {
  private constructor(
    readonly library: VerifiedTemplateLibrary,
    readonly origin: Readonly<PortableTemplateOrigin>,
  ) {}
  static async captured(source: CapturedPackageSource, root: string) {
    const normalized = root === "" ? "" : sourcePath(root),
      library = await capturedTemplateLibrary(source, normalized);
    return Object.freeze(
      new PortableTemplateSource(
        library,
        Object.freeze(
          portableTemplateOrigin({
            kind: "captured",
            source: source.descriptor.origin,
            root: normalized,
            sha256: source.digest,
          }),
        ),
      ),
    );
  }
  static async read(bytes: Uint8Array, name: unknown) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length > PORTABLE_TEMPLATE_JSON_BYTES ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 160 ||
      /[\p{Cc}\p{Cf}\\/]/u.test(name)
    )
      throw new PortableRegistryError("invalidInput");
    const captured = new Uint8Array(bytes);
    const library = await parsePortableTemplateBundle(captured);
    return Object.freeze(
      new PortableTemplateSource(
        library,
        Object.freeze(portableTemplateOrigin({ kind: "upload", name, sha256: await contentSha256(captured) })),
      ),
    );
  }
  static async authored(
    template: VerifiedPortableTemplate,
    draft: Pick<TemplateDraftRecord, "id" | "revision" | "digest" | "removed">,
  ) {
    if (template.digest !== draft.digest || draft.removed) throw new PortableRegistryError("draftConflict");
    const bytes = exportPortableTemplates([template]),
      library = await parsePortableTemplateBundle(bytes);
    return Object.freeze(
      new PortableTemplateSource(
        library,
        Object.freeze(
          portableTemplateOrigin({
            kind: "authoring",
            draftId: draft.id,
            revision: draft.revision,
            digest: draft.digest,
            sha256: await contentSha256(bytes),
          }),
        ),
      ),
    );
  }
}
