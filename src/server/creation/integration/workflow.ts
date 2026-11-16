import type { SkillCatalog } from "../../skills/catalog/service.js";
import type { CreationSkillSelection } from "../../../shared/creation/contracts.js";
import { SkillRegistryError } from "../../skills/errors.js";
import { CreationError } from "../contracts.js";
import { SKILL_LIMITS } from "../../../shared/skills/contracts.js";

/** The application execution scaffold is not a user-selected writing skill. */
export async function documentCreationWorkflow(
  skills: Pick<SkillCatalog, "detail">,
): Promise<CreationSkillSelection | null> {
  try {
    const pack = (await skills.detail("panda-force.document-creation", "1.0.0")).package;
    if (pack.removed || !pack.active || !pack.exports.some((item) => item.id === "writing" && item.enabled))
      return null;
    return { packageId: pack.id, version: pack.version, digest: pack.digest, id: "writing", parameters: {} };
  } catch (error) {
    if (error instanceof SkillRegistryError && error.code === "notInstalled") return null;
    throw error;
  }
}
export async function creationExecutionSelections(
  skills: Pick<SkillCatalog, "detail">,
  selections: readonly CreationSkillSelection[],
) {
  const definitions = new Map<string, Awaited<ReturnType<SkillCatalog["detail"]>>>();
  let hasWorkflow = false;
  for (const selection of selections) {
    const key = JSON.stringify([selection.packageId, selection.version]);
    let pack = definitions.get(key);
    if (!pack) {
      pack = await skills.detail(selection.packageId, selection.version);
      definitions.set(key, pack);
    }
    if (pack.package.manifest.skills.some((skill) => skill.id === selection.id && skill.role === "workflow")) {
      hasWorkflow = true;
      break;
    }
  }
  if (hasWorkflow) return selections;
  const workflow = await documentCreationWorkflow(skills);
  if (!workflow) throw new CreationError("defaultWorkflowMissing");
  if (selections.length >= SKILL_LIMITS.selections) throw new CreationError("invalidInput");
  return [workflow, ...selections];
}
