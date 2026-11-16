import { SKILL_LIMITS, type SkillPackManifest } from "./contracts.js";
import { skillAssert } from "./errors.js";
import {
  compareVersions,
  localized,
  packageId,
  resourcePath,
  validateResourcePaths,
  version,
} from "./manifest/identity.js";
import { https, list, record, text, unique } from "./manifest/primitives.js";
import { skillDefinition } from "./manifest/skill.js";
export function validateSkillManifest(value: unknown): SkillPackManifest {
  const row = record(value, [
    "schemaVersion",
    "kind",
    "id",
    "version",
    "name",
    "description",
    "publisher",
    "repository",
    "license",
    "requires",
    "files",
    "skills",
  ]);
  skillAssert(row.schemaVersion === 1 && row.kind === "panda-force.skill-pack", "invalidManifest", "schemaVersion");
  const publisher = record(row.publisher, ["name", "homepage"]),
    license = record(row.license, ["expression", "file"]),
    requires = record(row.requires, ["skillApi", "pandaForce"]);
  skillAssert(requires.skillApi === 1, "incompatibleVersion", "requires.skillApi");
  const bounds = requires.pandaForce === undefined ? undefined : record(requires.pandaForce, ["min", "maxExclusive"]);
  const min = bounds?.min === undefined ? undefined : version(bounds.min),
    maxExclusive = bounds?.maxExclusive === undefined ? undefined : version(bounds.maxExclusive);
  skillAssert(
    min === undefined || maxExclusive === undefined || compareVersions(min, maxExclusive) < 0,
    "invalidManifest",
    "requires.pandaForce",
  );
  const files = list(row.files, resourcePath, 1, SKILL_LIMITS.files, "files"),
    skills = list(row.skills, skillDefinition, 1, SKILL_LIMITS.exports, "skills");
  unique(files, (value) => value.toLowerCase(), "files");
  validateResourcePaths(["panda-skills.json", ...files]);
  unique(skills, (value) => value.id, "skills");
  skillAssert(!files.some((path) => path.toLowerCase() === "panda-skills.json"), "invalidResourcePath", "files");
  const declared = new Set(files),
    licenseFile = resourcePath(license.file);
  const required = [
    licenseFile,
    ...skills.flatMap((skill) => [
      skill.instructions,
      ...(skill.template ? [skill.template] : []),
      ...(skill.previews || []),
      ...(skill.cover ? [skill.cover.path] : []),
    ]),
  ];
  skillAssert(
    required.every((path) => declared.has(path)),
    "missingResource",
    "files",
  );
  for (const skill of skills) {
    skillAssert(
      /\.(?:md|txt)$/i.test(skill.instructions) && (!skill.template || /\.(?:md|txt)$/i.test(skill.template)),
      "invalidResource",
      "instructions",
    );
    skillAssert(
      [...(skill.previews || []), ...(skill.cover ? [skill.cover.path] : [])].every((path) =>
        /\.(?:png|jpe?g|webp)$/i.test(path),
      ),
      "invalidResource",
      "previews",
    );
    skillAssert(
      skill.composition.appliesTo.some((type) => skill.outputTypes.includes(type)),
      "incompatibleOutput",
      skill.id,
    );
  }
  return {
    schemaVersion: 1,
    kind: "panda-force.skill-pack",
    id: packageId(row.id),
    version: version(row.version),
    name: localized(row.name, 160),
    description: localized(row.description, 2000, true),
    publisher: {
      name: text(publisher.name, 160, "publisher.name"),
      ...(publisher.homepage === undefined ? {} : { homepage: https(publisher.homepage, "publisher.homepage") }),
    },
    ...(row.repository === undefined ? {} : { repository: https(row.repository, "repository") }),
    license: { expression: text(license.expression, 120, "license.expression"), file: licenseFile },
    requires: {
      skillApi: 1,
      ...(bounds
        ? {
            pandaForce: {
              ...(min === undefined ? {} : { min }),
              ...(maxExclusive === undefined ? {} : { maxExclusive }),
            },
          }
        : {}),
    },
    files,
    skills,
  };
}
export function assertSkillCompatibility(manifest: SkillPackManifest, applicationVersion: string): void {
  const bounds = manifest.requires.pandaForce;
  version(applicationVersion);
  skillAssert(
    (!bounds?.min || compareVersions(applicationVersion, bounds.min) >= 0) &&
      (!bounds?.maxExclusive || compareVersions(applicationVersion, bounds.maxExclusive) < 0),
    "incompatibleVersion",
    "requires.pandaForce",
  );
}
