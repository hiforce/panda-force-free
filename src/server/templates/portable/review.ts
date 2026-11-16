import { contentSha256 } from "../../../shared/packages/digest.js";
import { PortableTemplateError } from "../../../shared/templates/portable/errors.js";
import type { PortableRegistrySnapshot, PortableTemplateReview } from "../../../shared/templates/portable/registry.js";
import { PortableTemplateTypes } from "../../../shared/templates/types/registry.js";
import { PortableRegistryError } from "./errors.js";
import type { PortableTemplateSource } from "./source.js";
import { portableSelectionKeys } from "./commands.js";

export function portableCandidateKey(id: string, version: string) {
  return id + "@" + version;
}
export function selectedPortableTemplates(upload: PortableTemplateSource, selected: unknown) {
  const keys = portableSelectionKeys(selected);
  const templates = keys.map((key) =>
    upload.library.templates.find((value) => portableCandidateKey(value.manifest.id, value.manifest.version) === key),
  );
  if (templates.some((value) => !value)) throw new PortableRegistryError("invalidInput");
  return { keys, templates: templates.map((value) => value!) };
}
/** Metadata inspection and type compatibility do not grant skills, renderer access or publication authority. */
export async function reviewPortableTemplates(
  upload: PortableTemplateSource,
  snapshot: PortableRegistrySnapshot,
  types: PortableTemplateTypes,
  selected?: unknown,
): Promise<PortableTemplateReview> {
  const candidates = upload.library.templates.map((template) => {
    let issue: PortableTemplateError["code"] | null = null;
    try {
      types.prepare(template);
    } catch (error) {
      if (!(error instanceof PortableTemplateError)) throw error;
      issue = error.code;
    }
    return {
      key: portableCandidateKey(template.manifest.id, template.manifest.version),
      digest: template.digest,
      manifest: template.manifest,
      supported: issue === null,
      issue,
      installed: snapshot.templates.some(
        (value) =>
          value.id === template.manifest.id &&
          value.version === template.manifest.version &&
          value.digest === template.digest,
      ),
    };
  });
  const keys =
    selected === undefined
      ? candidates
          .filter((item) => item.supported)
          .map((item) => item.key)
          .sort()
      : selectedPortableTemplates(upload, selected).keys;
  const reviewHash = await contentSha256(
    JSON.stringify({
      revision: snapshot.revision,
      source: upload.origin,
      selected: keys,
      candidates: candidates.map((item) => [item.key, item.digest, item.supported, item.issue]),
    }),
  );
  return { revision: snapshot.revision, source: upload.origin, selected: keys, reviewHash, candidates };
}
