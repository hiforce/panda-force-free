import hongKong from "../i18n/locales/zh-HK/builtinSkills.json";
import taiwan from "../i18n/locales/zh-TW/builtinSkills.json";
import type { InstalledSkillPack } from "../skills/registry.js";
import type { SkillDefinition } from "../skills/contracts.js";

const regional: Record<string, Readonly<Record<string, string>>> = { "zh-HK": hongKong, "zh-TW": taiwan };
function trustedEssentials(pack: Pick<InstalledSkillPack, "id" | "version" | "origin">) {
  return (
    pack.id === "panda-force.essentials" &&
    pack.version === "1.0.0" &&
    pack.origin.kind === "builtin" &&
    pack.origin.id === pack.id
  );
}

/** Regional display metadata never changes installed bundles, digests or task instructions. */
export function skillDisplayDefinition(pack: InstalledSkillPack, skill: SkillDefinition): SkillDefinition {
  const prefix = skill.id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (!trustedEssentials(pack) || !hongKong[(prefix + "Name") as keyof typeof hongKong]) return skill;
  const labels = (original: Readonly<Record<string, string>>, key: string) => ({
    ...Object.fromEntries(Object.entries(regional).map(([locale, messages]) => [locale, messages[key]!])),
    ...original,
  });
  return {
    ...skill,
    name: labels(skill.name, prefix + "Name"),
    description: labels(skill.description, prefix + "Description"),
    readme: {
      ...Object.fromEntries(
        Object.entries(regional).map(([locale, messages]) => [
          locale,
          messages[prefix + "Description"] +
            "\n\n" +
            messages.deliverable +
            "\n\n" +
            messages.exampleLabel +
            ": " +
            messages[prefix + "Example"],
        ]),
      ),
      ...skill.readme,
    },
    parameters: skill.parameters.map((parameter) => ({
      ...parameter,
      ...(["audience", "depth"].includes(parameter.id) ? { label: labels(parameter.label, parameter.id) } : {}),
      ...(parameter.type === "choice" && parameter.id === "depth"
        ? {
            options: parameter.options.map((option) => ({ ...option, label: labels(option.label, option.value) })),
          }
        : {}),
    })),
  };
}

export function skillDisplayPackName(pack: InstalledSkillPack) {
  return trustedEssentials(pack)
    ? {
        "zh-HK": hongKong.packageName,
        "zh-TW": taiwan.packageName,
        ...pack.manifest.name,
      }
    : pack.manifest.name;
}
