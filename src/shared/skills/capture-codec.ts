import type { SkillCapture } from "./registry.js";
import type { FrozenSkillSelection, SkillComposition } from "./composition.js";
import { SKILL_CAPABILITIES, SKILL_LIMITS, SKILL_OUTPUTS } from "./contracts.js";
import { record, text, list, oneOf, unique } from "./manifest/primitives.js";
import { packageId, localId, qualifiedSkill, version } from "./manifest/identity.js";
import { constraints } from "./manifest/skill.js";
import { skillDigest, skillOperationId, skillOrigin } from "./registry-validation.js";
import { skillAssert } from "./errors.js";
import { freezeSkillValue } from "./resources.js";

function instructions(value: unknown): string {
  skillAssert(
    typeof value === "string" && new TextEncoder().encode(value).length <= SKILL_LIMITS.taskInstructionBytes,
    "packageTooLarge",
    "instructions",
  );
  return value;
}
function parameters(value: unknown): Record<string, string | number | boolean> {
  skillAssert(value && typeof value === "object" && !Array.isArray(value), "invalidParameters");
  const input = record(value, Object.keys(value)),
    result: Record<string, string | number | boolean> = {};
  skillAssert(Object.keys(input).length <= 32, "invalidParameters");
  for (const [key, value] of Object.entries(input)) {
    localId(key);
    skillAssert(
      typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= 4000),
      "invalidParameters",
      key,
    );
    result[key] = value;
  }
  return result;
}
function selection(value: unknown): FrozenSkillSelection {
  const row = record(value, [
      "packageId",
      "version",
      "digest",
      "id",
      "qualifiedId",
      "role",
      "instructions",
      "template",
      "parameters",
    ]),
    id = localId(row.id),
    pack = packageId(row.packageId),
    qualifiedId = qualifiedSkill(row.qualifiedId);
  skillAssert(qualifiedId === pack + "/" + id, "invalidIdentity");
  return {
    packageId: pack,
    version: version(row.version),
    digest: skillDigest(row.digest),
    id,
    qualifiedId,
    role: oneOf(row.role, ["workflow", "template", "style"], "role"),
    instructions: instructions(row.instructions),
    ...(row.template === undefined ? {} : { template: instructions(row.template) }),
    parameters: parameters(row.parameters),
  };
}
/** Validate the immutable execution snapshot without reopening mutable packages or reinterpreting their definitions. */
export function decodeSkillComposition(value: unknown, options: { workflowRequired?: boolean } = {}): SkillComposition {
  const row = record(value, ["schema", "mode", "outputType", "skills", "capabilities", "constraints"]);
  skillAssert(row.schema === 1, "invalidManifest", "schema");
  skillAssert(row.mode === undefined || row.mode === "guidance", "invalidManifest", "mode");
  const guidance = row.mode === "guidance",
    skills = list(row.skills, selection, guidance ? 0 : 1, SKILL_LIMITS.selections, "skills"),
    capabilities = list(
      row.capabilities,
      (value) => oneOf(value, SKILL_CAPABILITIES, "capabilities"),
      0,
      SKILL_CAPABILITIES.length,
      "capabilities",
    );
  unique(skills, (skill) => skill.qualifiedId, "skills");
  unique(capabilities, (capability) => capability, "capabilities");
  const workflows = skills.filter((skill) => skill.role === "workflow").length;
  skillAssert(guidance || options.workflowRequired === false ? workflows <= 1 : workflows === 1, "workflowRequired");
  skillAssert(
    skills.reduce(
      (size, skill) =>
        size +
        new TextEncoder().encode(skill.instructions).length +
        new TextEncoder().encode(skill.template ?? "").length,
      0,
    ) <= SKILL_LIMITS.taskInstructionBytes,
    "packageTooLarge",
    "instructions",
  );
  return {
    schema: 1,
    ...(guidance ? { mode: "guidance" as const } : {}),
    outputType: oneOf(row.outputType, SKILL_OUTPUTS, "outputType"),
    skills,
    capabilities,
    constraints: constraints(row.constraints),
  };
}
export function decodeSkillCapture(value: unknown, options: { workflowRequired?: boolean } = {}): SkillCapture {
  const row = record(value, [
      "id",
      "owner",
      "requestBinding",
      "registryRevision",
      "createdAt",
      "composition",
      "origins",
    ]),
    composition = decodeSkillComposition(row.composition, options),
    origins = list(
      row.origins,
      (value) => {
        const entry = record(value, ["id", "version", "digest", "origin"]);
        return {
          id: packageId(entry.id),
          version: version(entry.version),
          digest: skillDigest(entry.digest),
          origin: skillOrigin(entry.origin),
        };
      },
      composition.mode === "guidance" ? 0 : 1,
      SKILL_LIMITS.selections,
      "origins",
    );
  unique(origins, (origin) => origin.id + "@" + origin.version, "origins");
  skillAssert(
    origins.every((origin) =>
      composition.skills.some(
        (skill) => skill.packageId === origin.id && skill.version === origin.version && skill.digest === origin.digest,
      ),
    ) &&
      composition.skills.every((skill) =>
        origins.some(
          (origin) =>
            origin.id === skill.packageId && origin.version === skill.version && origin.digest === skill.digest,
        ),
      ),
    "invalidIdentity",
    "origins",
  );
  for (const key of ["registryRevision", "createdAt"])
    skillAssert(Number.isSafeInteger(row[key]) && Number(row[key]) >= 0, "invalidManifest", key);
  return freezeSkillValue({
    id: skillOperationId(row.id),
    owner: text(row.owner, 200, "owner"),
    requestBinding: skillDigest(row.requestBinding),
    registryRevision: Number(row.registryRevision),
    createdAt: Number(row.createdAt),
    composition,
    origins,
  });
}
