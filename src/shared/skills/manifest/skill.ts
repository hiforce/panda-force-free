import {
  SKILL_CAPABILITIES,
  SKILL_CATEGORIES,
  SKILL_OUTPUTS,
  type SkillDefinition,
  type SkillConstraints,
} from "../contracts.js";
import { localId, locale, localized, qualifiedSkill, resourcePath } from "./identity.js";
import { parameter } from "./parameters.js";
import { boolean, https, list, oneOf, record, text, unique } from "./primitives.js";
export function constraints(value: unknown): SkillConstraints {
  const row = record(value, ["aspectRatio", "outputLocale", "brand"], "composition.constraints");
  return {
    ...(row.aspectRatio === undefined
      ? {}
      : {
          aspectRatio: oneOf(
            row.aspectRatio,
            ["auto", "1:1", "16:9", "9:16", "2:3", "3:2", "4:3", "3:4"],
            "aspectRatio",
          ),
        }),
    ...(row.outputLocale === undefined ? {} : { outputLocale: locale(row.outputLocale) }),
    ...(row.brand === undefined ? {} : { brand: text(row.brand, 120, "brand") }),
  };
}
export function skillDefinition(value: unknown): SkillDefinition {
  const row = record(value, [
    "id",
    "category",
    "role",
    "name",
    "description",
    "instructions",
    "inputs",
    "parameters",
    "capabilities",
    "outputTypes",
    "template",
    "previews",
    "cover",
    "readme",
    "composition",
    "entitlement",
  ]);
  const inputs = list(
    row.inputs,
    (value) => {
      const input = record(value, ["id", "kind", "required"]);
      return {
        id: localId(input.id),
        kind: oneOf(input.kind, ["text", "document-ref", "asset-ref"], "inputs.kind"),
        required: boolean(input.required, "inputs.required"),
      };
    },
    0,
    32,
    "inputs",
  );
  const parameters = list(row.parameters, parameter, 0, 32, "parameters"),
    capabilities = list(
      row.capabilities,
      (value) => oneOf(value, SKILL_CAPABILITIES, "capabilities"),
      0,
      9,
      "capabilities",
    ),
    outputTypes = list(row.outputTypes, (value) => oneOf(value, SKILL_OUTPUTS, "outputTypes"), 1, 5, "outputTypes");
  const composition = record(row.composition, ["appliesTo", "conflictsWith", "constraints"]),
    appliesTo = list(
      composition.appliesTo,
      (value) => oneOf(value, SKILL_OUTPUTS, "composition.appliesTo"),
      1,
      5,
      "composition.appliesTo",
    ),
    conflictsWith = list(composition.conflictsWith, qualifiedSkill, 0, 64, "composition.conflictsWith");
  unique(inputs, (value) => value.id, "inputs");
  unique(parameters, (value) => value.id, "parameters");
  unique(capabilities, (value) => value, "capabilities");
  unique(outputTypes, (value) => value, "outputTypes");
  unique(appliesTo, (value) => value, "composition.appliesTo");
  unique(conflictsWith, (value) => value, "composition.conflictsWith");
  const previews = row.previews === undefined ? undefined : list(row.previews, resourcePath, 0, 8, "previews");
  if (previews) unique(previews, (value) => value.toLowerCase(), "previews");
  const cover = row.cover === undefined ? undefined : record(row.cover, ["path", "alt"], "cover");
  const entitlement = row.entitlement === undefined ? undefined : record(row.entitlement, ["issuer", "product"]);
  return {
    id: localId(row.id),
    category: oneOf(row.category, SKILL_CATEGORIES, "category"),
    role: oneOf(row.role, ["workflow", "template", "style"], "role"),
    name: localized(row.name, 160),
    description: localized(row.description, 2000, true),
    instructions: resourcePath(row.instructions),
    inputs,
    parameters,
    capabilities,
    outputTypes,
    ...(row.template === undefined ? {} : { template: resourcePath(row.template) }),
    ...(previews === undefined ? {} : { previews }),
    ...(cover ? { cover: { path: resourcePath(cover.path), alt: localized(cover.alt, 500, true) } } : {}),
    ...(row.readme === undefined ? {} : { readme: localized(row.readme, 12000, true) }),
    composition: { appliesTo, conflictsWith, constraints: constraints(composition.constraints) },
    ...(entitlement
      ? {
          entitlement: {
            issuer: https(entitlement.issuer, "entitlement.issuer"),
            product: text(entitlement.product, 160, "entitlement.product"),
          },
        }
      : {}),
  };
}
