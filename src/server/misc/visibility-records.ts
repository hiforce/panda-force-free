import { normalizeProjectVisibilityKey } from "../../shared/project-visibility.js";
import type { ProjectVisibility } from "../../shared/engine/types.js";
import { isRecord } from "../../shared/records.js";
export function projectVisibilityState(value: unknown): ProjectVisibility {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["revision", "hiddenProjects"].includes(key)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !isRecord(value.hiddenProjects)
  )
    throw Error("Invalid project visibility store");
  const hiddenProjects: ProjectVisibility["hiddenProjects"] = {};
  for (const [key, entry] of Object.entries(value.hiddenProjects)) {
    if (
      normalizeProjectVisibilityKey(key) !== key ||
      !isRecord(entry) ||
      Object.keys(entry).some((key) => key !== "hiddenAt") ||
      !Number.isSafeInteger(entry.hiddenAt) ||
      Number(entry.hiddenAt) <= 0 ||
      Number(entry.hiddenAt) > Number(value.revision)
    )
      throw Error("Invalid hidden project");
    hiddenProjects[key] = { hiddenAt: Number(entry.hiddenAt) };
  }
  return { revision: Number(value.revision), hiddenProjects };
}
