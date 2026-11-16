import { internalExecutionSkill, skillPresentationType } from "../../../shared/skills/presentation.js";
import { localizedPresentation } from "../../../shared/presentation/localized.js";
import type { SkillRegistryPage } from "../../../shared/skills/registry.js";
import { managedTemplateKey, type ManagedTemplate } from "../../../shared/templates/catalog.js";
import type { TemplateCatalogSource } from "../ports.js";
import { TemplateCatalogError } from "../errors.js";
import { skillDisplayDefinition } from "../../../shared/presentation/skill-display.js";

/** User-facing skills share visibility rules with creation; internal execution scaffolds stay in the capability registry. */
export function skillTemplateSource(
  read: (cursor?: string, limit?: number) => SkillRegistryPage | Promise<SkillRegistryPage>,
): TemplateCatalogSource {
  return {
    registry: "skills",
    async read() {
      let cursor: string | undefined, revision: number | undefined;
      const seen = new Set<string>(),
        templates: ManagedTemplate[] = [];
      do {
        const page = await read(cursor, 100);
        if (revision !== undefined && page.revision !== revision) throw new TemplateCatalogError("catalogChanged");
        revision = page.revision;
        for (const pack of page.packages) {
          for (const original of pack.manifest.skills) {
            const skill = skillDisplayDefinition(pack, original);
            if (internalExecutionSkill(pack, skill)) continue;
            const reference = {
              registry: "skills" as const,
              kind: "skill" as const,
              packageId: pack.id,
              exportId: skill.id,
              version: pack.version,
              digest: pack.digest,
            };
            const enabled = pack.exports.find((entry) => entry.id === skill.id)?.enabled === true;
            const type = skillPresentationType(skill);
            templates.push({
              key: managedTemplateKey(reference),
              reference,
              templateType: type,
              categories: [skill.category],
              label: localizedPresentation(skill.name, skill.description),
              ...(skill.cover || skill.previews?.length ? { artwork: { alt: skill.cover?.alt || skill.name } } : {}),
              publisher: pack.manifest.publisher.name,
              license: pack.manifest.license.expression,
              origin: structuredClone(pack.origin),
              state: {
                enabled: !pack.removed && enabled,
                packageEnabled: !pack.removed,
                exportEnabled: enabled,
                active: !pack.removed && pack.active && enabled,
                removed: pack.removed,
              },
              compatibility: { engines: [], formats: [], outputs: [...skill.outputTypes] },
              actions: {
                editor: null,
                preview: "skill-template",
                export: "skill-package",
                setEnabled: !pack.removed && skill.capabilities.every((capability) => pack.grants.includes(capability)),
                activate: !pack.removed && !pack.active && enabled,
              },
            });
          }
        }
        if (page.nextCursor && (seen.has(page.nextCursor) || seen.size >= 32))
          throw new TemplateCatalogError("unavailable");
        if (page.nextCursor) seen.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return { registry: "skills", revision: "skill-library-v2:" + String(revision), templates };
    },
  };
}
