import { contentSha256 } from "../../packages/digest.js";
import {
  DEFAULT_TEMPLATE_RESOURCE_POLICY,
  type TemplateResourcePolicy,
  type VerifiedPortableTemplate,
  type VerifiedTemplateLibrary,
  type TemplateLibraryEntry,
} from "./contracts.js";
import { templateAssert } from "./errors.js";
import { validatePortableTemplateIndex } from "./manifest.js";
import { templateResourcePolicy, verifyPortableTemplateResources } from "./resources.js";
import {
  freezeTemplate,
  templateJson,
  templateList,
  templateObject,
  templatePathSet,
  templateUtf8,
} from "./validation.js";

export const PORTABLE_TEMPLATE_JSON_BYTES = 96 * 1024 * 1024;
function decode(value: unknown, max: number): Uint8Array {
  templateAssert(typeof value === "string", "invalidBundle");
  templateAssert(value.length <= Math.ceil(max / 3) * 4, "packageTooLarge");
  // The canonical alphabet and padding are verified before allocating decoded resources.
  templateAssert(value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value), "invalidBundle");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  templateAssert(!value.slice(0, value.length - padding).includes("="), "invalidBundle");
  const decoded = Uint8Array.from(atob(value), (value) => value.charCodeAt(0));
  templateAssert(decoded.length <= max, "packageTooLarge");
  templateAssert(encode(decoded) === value, "invalidBundle");
  return decoded;
}
function encode(bytes: Uint8Array) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 16384)
    result += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return btoa(result);
}
/** JSON and future archive/repository readers share this logical file-tree verifier, never filesystem extraction. */
export async function verifyPortableTemplateTree(
  indexValue: unknown,
  source: Iterable<{ path: string; bytes: Uint8Array }>,
  options: TemplateResourcePolicy = DEFAULT_TEMPLATE_RESOURCE_POLICY,
): Promise<VerifiedTemplateLibrary> {
  const policy = templateResourcePolicy(options),
    index = freezeTemplate(validatePortableTemplateIndex(indexValue)),
    paths = templatePathSet(),
    files = new Map<string, Uint8Array>();
  templateAssert(index.entries.length <= policy.templates, "packageTooLarge");
  let byteLength = 0;
  for (const item of source) {
    const path = paths(item.path);
    templateAssert(
      item.bytes instanceof Uint8Array &&
        item.bytes.length <= Math.max(policy.manifestBytes, policy.fileBytes) &&
        files.size < policy.files,
      "packageTooLarge",
    );
    byteLength += item.bytes.length;
    templateAssert(byteLength <= policy.totalBytes, "packageTooLarge");
    files.set(path, new Uint8Array(item.bytes));
  }
  const used = new Set<string>(),
    templates: VerifiedPortableTemplate[] = [];
  for (const entry of index.entries) {
    const raw = files.get(entry.manifest);
    templateAssert(raw, "resourceMissing");
    templateAssert(raw.length <= policy.manifestBytes, "packageTooLarge");
    templateAssert((await contentSha256(raw)) === entry.sha256, "resourceMismatch");
    const metadata = templateObject(templateJson(raw), [
      "schemaVersion",
      "kind",
      "id",
      "version",
      "templateType",
      "categories",
      "name",
      "description",
      "publisher",
      "license",
      "tags",
      "parameters",
      "payload",
      "requires",
      "composition",
      "previews",
      "files",
    ]);
    const prefix = entry.manifest.includes("/") ? entry.manifest.slice(0, entry.manifest.lastIndexOf("/") + 1) : "";
    const resources = templateList(
      metadata.files,
      (value) => {
        const file = templateObject(value, ["path", "bytes", "sha256", "mediaType"]);
        templateAssert(typeof file.path === "string");
        const path = prefix + file.path;
        templateAssert(path !== entry.manifest, "resourceMismatch");
        const bytes = files.get(path);
        templateAssert(bytes, "resourceMissing");
        used.add(path);
        return { path: file.path, bytes };
      },
      512,
      1,
    );
    const verified = await verifyPortableTemplateResources(raw, resources, policy),
      manifest = verified.manifest;
    templateAssert(
      manifest.id === entry.id &&
        manifest.version === entry.version &&
        manifest.templateType === entry.templateType &&
        [...manifest.categories].sort().join("\n") === [...entry.categories].sort().join("\n"),
      "resourceMismatch",
    );
    templates.push(verified);
    used.add(entry.manifest);
  }
  templateAssert(used.size === files.size, "resourceMismatch");
  return Object.freeze({ index, templates: Object.freeze(templates), byteLength });
}
export async function parsePortableTemplateBundle(
  bytes: Uint8Array,
  options: TemplateResourcePolicy = DEFAULT_TEMPLATE_RESOURCE_POLICY,
): Promise<VerifiedTemplateLibrary> {
  templateAssert(bytes instanceof Uint8Array && bytes.length <= PORTABLE_TEMPLATE_JSON_BYTES, "packageTooLarge");
  const policy = templateResourcePolicy(options),
    input = templateObject(templateJson(bytes), ["schemaVersion", "kind", "index", "files"]);
  templateAssert(input.schemaVersion === 1 && input.kind === "panda-force.template-bundle", "invalidBundle");
  let total = 0;
  const files = templateList(
    input.files,
    (value) => {
      const file = templateObject(value, ["path", "encoding", "data"]);
      templateAssert(file.encoding === "base64" && typeof file.path === "string", "invalidBundle");
      const bytes = decode(file.data, Math.max(policy.fileBytes, policy.manifestBytes));
      total += bytes.length;
      templateAssert(total <= policy.totalBytes, "packageTooLarge");
      return { path: file.path, bytes };
    },
    Math.min(4096, policy.files),
    1,
  );
  return verifyPortableTemplateTree(input.index, files, policy);
}
/** Export changes only collection placement; exact manifest bytes and resource identity are retained. */
export function exportPortableTemplates(templates: readonly VerifiedPortableTemplate[]): Uint8Array {
  templateAssert(
    templates.length > 0 &&
      templates.length <= 256 &&
      new Set(templates.map((template) => template.manifest.id + "@" + template.manifest.version)).size ===
        templates.length,
    "invalidBundle",
  );
  const entries: TemplateLibraryEntry[] = [],
    files: { path: string; encoding: "base64"; data: string }[] = [];
  for (const template of templates) {
    const manifest = template.manifest,
      prefix = `templates/${manifest.id}/${manifest.version}/`;
    entries.push({
      id: manifest.id,
      version: manifest.version,
      templateType: manifest.templateType,
      categories: manifest.categories,
      name: manifest.name,
      description: manifest.description,
      manifest: prefix + "panda-template.json",
      sha256: template.manifestSha256,
    });
    files.push({ path: prefix + "panda-template.json", encoding: "base64", data: encode(template.readManifest()) });
    for (const file of manifest.files)
      files.push({ path: prefix + file.path, encoding: "base64", data: encode(template.read(file.path)) });
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      kind: "panda-force.template-bundle",
      index: {
        schemaVersion: 1,
        kind: "panda-force.template-library",
        id: "panda.template-export",
        name: { en: "Exported templates" },
        entries,
      },
      files,
    }),
  );
  templateAssert(bytes.length <= PORTABLE_TEMPLATE_JSON_BYTES, "packageTooLarge");
  return bytes;
}
export const portableTemplateText = templateUtf8;
