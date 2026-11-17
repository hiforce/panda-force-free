import type { SkillCatalog } from "./service.js";
import type { CreationSkillSelection } from "../../../shared/creation/contracts.js";
import type { SessionSkillSummary } from "../../../shared/session-skills.js";
import { skillDisplayDefinition } from "../../../shared/presentation/skill-display.js";

/** Presentation metadata is resolved against the selected digest, without changing the captured instructions. */
export function createSkillSummaryReader(catalog: Pick<SkillCatalog, "detail">) {
  const cache = new Map<string, Promise<SessionSkillSummary["name"]>>();
  return async (selections: readonly CreationSkillSelection[]): Promise<SessionSkillSummary[]> =>
    Promise.all(
      selections.map(async (selection) => {
        const key = JSON.stringify([selection.packageId, selection.version, selection.digest, selection.id]);
        let name = cache.get(key);
        if (!name) {
          name = (async () => {
            try {
              const detail = await catalog.detail(selection.packageId, selection.version);
              const pack = detail.package;
              const definition =
                pack?.digest === selection.digest
                  ? pack.manifest.skills.find((entry) => entry.id === selection.id)
                  : undefined;
              return pack && definition ? skillDisplayDefinition(pack, definition).name : { en: selection.id };
            } catch {
              return { en: selection.id };
            }
          })();
          cache.set(key, name);
          while (cache.size > 128) cache.delete(cache.keys().next().value!);
        }
        return { selection, name: await name };
      }),
    );
}
