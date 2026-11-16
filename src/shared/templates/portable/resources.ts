import { contentSha256 } from "../../packages/digest.js";
import {
  DEFAULT_TEMPLATE_RESOURCE_POLICY,
  type TemplateResource,
  type TemplateResourcePolicy,
  type VerifiedPortableTemplate,
} from "./contracts.js";
import { templateAssert } from "./errors.js";
import { validatePortableTemplateManifest } from "./manifest.js";
import {
  freezeTemplate,
  templateInteger,
  templateJson,
  templatePathSet,
  templateText,
  templateUtf8,
} from "./validation.js";

export function templateResourcePolicy(value: TemplateResourcePolicy): Readonly<TemplateResourcePolicy> {
  for (const number of Object.values(value)) templateInteger(number, 1, Number.MAX_SAFE_INTEGER);
  templateAssert(
    value.fileBytes <= value.totalBytes &&
      value.payloadBytes <= value.fileBytes &&
      value.manifestBytes <= value.totalBytes,
  );
  return Object.freeze({ ...value });
}
/** Capture resource ownership before hashing so later caller mutation cannot change accepted content. */
export async function verifyPortableTemplateResources(
  manifestBytes: Uint8Array,
  source: Iterable<TemplateResource>,
  options: TemplateResourcePolicy = DEFAULT_TEMPLATE_RESOURCE_POLICY,
): Promise<VerifiedPortableTemplate> {
  const policy = templateResourcePolicy(options);
  templateAssert(
    manifestBytes instanceof Uint8Array && manifestBytes.length <= policy.manifestBytes,
    "packageTooLarge",
  );
  const raw = new Uint8Array(manifestBytes),
    manifest = freezeTemplate(validatePortableTemplateManifest(templateJson(raw)));
  const resources = new Map<string, Uint8Array>(),
    paths = templatePathSet();
  let byteLength = raw.length;
  for (const file of source) {
    const path = paths(file.path),
      declaration = manifest.files.find((item) => item.path === path);
    templateAssert(declaration, "resourceMismatch");
    templateAssert(
      file.bytes instanceof Uint8Array && file.bytes.length <= policy.fileBytes && resources.size < policy.files,
      "packageTooLarge",
    );
    byteLength += file.bytes.length;
    templateAssert(byteLength <= policy.totalBytes, "packageTooLarge");
    templateAssert(file.bytes.length === declaration.bytes, "resourceMismatch");
    resources.set(path, new Uint8Array(file.bytes));
  }
  templateAssert(
    resources.size === manifest.files.length && manifest.files.every((file) => resources.has(file.path)),
    "resourceMissing",
  );
  templateAssert(resources.get(manifest.payload.path)!.length <= policy.payloadBytes, "packageTooLarge");
  const read = (path: string) => {
    const value = resources.get(path);
    templateAssert(value, "resourceMissing");
    return new Uint8Array(value);
  };
  templateText(templateUtf8(read(manifest.license.file)), policy.fileBytes);
  const manifestSha256 = await contentSha256(raw),
    stamps: [string, number, string][] = [];
  for (const file of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const bytes = resources.get(file.path)!,
      sha256 = await contentSha256(bytes);
    templateAssert(sha256 === file.sha256, "resourceMismatch");
    stamps.push([file.path, bytes.length, sha256]);
  }
  const digest = await contentSha256("PandaForce-Template-v1\n" + JSON.stringify([manifestSha256, stamps]));
  return Object.freeze({
    manifest,
    manifestSha256,
    digest,
    byteLength,
    readManifest: () => new Uint8Array(raw),
    read,
    text: (path: string) => templateUtf8(read(path)),
  });
}
