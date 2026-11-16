import type { PortableTemplateManifest, PortableTemplateIndex } from "./contracts.js";
import { templateAssert } from "./errors.js";
import { templateParameter } from "./parameters.js";
import {
  templateChoice,
  templateDigest,
  templateId,
  templateInteger,
  templateList,
  templateLocalized,
  templateObject,
  templatePath,
  templateText,
  templateUnique,
  templateVersion,
  templatePathSet,
} from "./validation.js";

export function templateCategories(value: unknown) {
  const values = templateList(
    value,
    (item) => {
      const name = templateText(item, 64);
      templateAssert(/^[a-z][a-z0-9-]*(?:[.][a-z][a-z0-9-]*)*$/.test(name));
      return name;
    },
    16,
    1,
  );
  templateUnique(values, (item) => item);
  return values;
}
function templateType(value: unknown) {
  const type = templateText(value, 100);
  templateAssert(/^[a-z][a-z0-9-]*(?:[.][a-z][a-z0-9-]*)+$/.test(type));
  return type;
}
export function validatePortableTemplateManifest(value: unknown): PortableTemplateManifest {
  const input = templateObject(value, [
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
  templateAssert(input.schemaVersion === 1 && input.kind === "panda-force.template");
  const publisher = templateObject(input.publisher, ["name", "homepage"]),
    license = templateObject(input.license, ["expression", "file"]),
    payload = templateObject(input.payload, ["format", "path"]),
    requires = templateObject(input.requires, ["adapters", "skills"]),
    composition = templateObject(input.composition, ["slots"]);
  let homepage: string | undefined;
  if (publisher.homepage !== undefined) {
    homepage = templateText(publisher.homepage, 1000);
    try {
      const url = new URL(homepage);
      templateAssert(url.protocol === "https:" && !url.username && !url.password && !url.hash && !/\s/.test(homepage));
    } catch {
      templateAssert(false);
    }
  }
  const parameters = templateList(input.parameters, templateParameter, 64),
    tags = templateList(input.tags, (value) => templateText(value, 64, true), 32);
  templateUnique(parameters, (item) => item.id);
  templateUnique(tags, (item) => item);
  const paths = templatePathSet();
  const files = templateList(
    input.files,
    (value) => {
      const file = templateObject(value, ["path", "sha256", "bytes", "mediaType"]);
      return {
        path: paths(file.path),
        sha256: templateDigest(file.sha256),
        bytes: templateInteger(file.bytes, 0, Number.MAX_SAFE_INTEGER),
        mediaType: templateText(file.mediaType, 120),
      };
    },
    512,
    1,
  );
  const previews = templateList(input.previews, templatePath, 8);
  templateUnique(previews, (item) => item);
  const format = templateText(payload.format, 100);
  templateAssert(/^[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/.test(format));
  const adapters = templateList(
    requires.adapters,
    (value) => {
      const item = templateObject(value, ["id", "api"]);
      return { id: templateId(item.id), api: templateInteger(item.api, 1, 100) };
    },
    16,
  );
  const skills = templateList(
    requires.skills,
    (value) => {
      const item = templateObject(value, ["packageId", "exportId", "version", "digest"]);
      return {
        packageId: templateId(item.packageId),
        exportId: templateId(item.exportId),
        version: templateVersion(item.version),
        digest: templateDigest(item.digest),
      };
    },
    64,
  );
  const slots = templateList(
    composition.slots,
    (value) => {
      const item = templateObject(value, ["id", "policy"]);
      return { id: templateId(item.id), policy: templateChoice(item.policy, ["single", "ordered", "merge"]) };
    },
    16,
  );
  templateUnique(adapters, (item) => item.id);
  templateUnique(skills, (item) => item.packageId + "/" + item.exportId);
  templateUnique(slots, (item) => item.id);
  const result: PortableTemplateManifest = {
    schemaVersion: 1,
    kind: "panda-force.template",
    id: templateId(input.id),
    version: templateVersion(input.version),
    templateType: templateType(input.templateType),
    categories: templateCategories(input.categories),
    name: templateLocalized(input.name),
    description: templateLocalized(input.description),
    publisher: { name: templateText(publisher.name, 160), ...(homepage === undefined ? {} : { homepage }) },
    license: { expression: templateText(license.expression, 120), file: templatePath(license.file) },
    tags,
    parameters,
    payload: { format, path: templatePath(payload.path) },
    requires: { adapters, skills },
    composition: { slots },
    previews,
    files,
  };
  for (const path of [result.payload.path, result.license.file, ...previews])
    templateAssert(
      files.some((file) => file.path === path),
      "resourceMissing",
    );
  templateAssert(files.find((file) => file.path === result.payload.path)?.mediaType === "application/json");
  return result;
}
export function validatePortableTemplateIndex(value: unknown): PortableTemplateIndex {
  const input = templateObject(value, ["schemaVersion", "kind", "id", "name", "entries"]);
  templateAssert(input.schemaVersion === 1 && input.kind === "panda-force.template-library");
  const entries = templateList(
    input.entries,
    (value) => {
      const item = templateObject(value, [
        "id",
        "version",
        "templateType",
        "categories",
        "name",
        "description",
        "manifest",
        "sha256",
      ]);
      return {
        id: templateId(item.id),
        version: templateVersion(item.version),
        templateType: templateType(item.templateType),
        categories: templateCategories(item.categories),
        name: templateLocalized(item.name),
        description: templateLocalized(item.description),
        manifest: templatePath(item.manifest),
        sha256: templateDigest(item.sha256),
      };
    },
    256,
  );
  templateUnique(entries, (item) => item.id + "@" + item.version);
  templateUnique(entries, (item) => item.manifest.toLowerCase());
  return {
    schemaVersion: 1,
    kind: "panda-force.template-library",
    id: templateId(input.id),
    name: templateLocalized(input.name),
    entries,
  };
}
