import type { SkillRegistryStore, SkillBundleStore } from "../ports.js";
import {
  composeSkills,
  type SkillCompositionAuthority,
  type SelectedSkill,
} from "../../../shared/skills/composition.js";
import { SKILL_LIMITS } from "../../../shared/skills/contracts.js";
import type { SkillCapture } from "../../../shared/skills/registry.js";
import { packageId, version, localId } from "../../../shared/skills/manifest/identity.js";
import { record } from "../../../shared/skills/manifest/primitives.js";
import { skillDigest } from "../../../shared/skills/registry-validation.js";
import { SkillRegistryError } from "../errors.js";
import { actor, clock, operation, parameters, requestHash } from "./validation.js";
export class InstalledSkillCapture {
  constructor(
    private registry: SkillRegistryStore,
    private bundles: SkillBundleStore,
    private applicationVersion: string,
    private now: () => number,
  ) {}
  async create(
    value: unknown,
    owner: unknown,
    authority: Omit<SkillCompositionAuthority, "applicationVersion">,
  ): Promise<SkillCapture> {
    const input = record(value, ["id", "requestBinding", "selections"]),
      id = operation(input.id),
      ownerId = actor(owner),
      binding = skillDigest(input.requestBinding);
    if (
      !Array.isArray(input.selections) ||
      (!input.selections.length && !authority.guidanceOnly) ||
      input.selections.length > SKILL_LIMITS.selections
    )
      throw new SkillRegistryError("invalidInput");
    const selections = input.selections.map((item) => {
      const row = record(item, ["packageId", "version", "digest", "id", "parameters"]);
      return {
        packageId: packageId(row.packageId),
        version: version(row.version),
        digest: skillDigest(row.digest),
        id: localId(row.id),
        parameters: parameters(row.parameters),
      };
    });
    const request = requestHash({
        id,
        requestBinding: binding,
        selections,
        outputType: authority.outputType,
        ...(authority.guidanceOnly
          ? { compositionMode: "artifact-guidance" }
          : authority.workflowRequired === false
            ? { compositionMode: "conversation-guidance" }
            : {}),
      }),
      prior = await this.registry.captured(ownerId, id, request);
    if (prior) return prior;
    const registryRevision = await this.registry.revision(),
      captured: SelectedSkill[] = [],
      origins: SkillCapture["origins"][number][] = [];
    for (const selection of selections) {
      const installed = await this.registry.get(selection.packageId, selection.version),
        skill = installed?.manifest.skills.find((skill) => skill.id === selection.id);
      if (
        !installed ||
        installed.digest !== selection.digest ||
        installed.removed ||
        !installed.active ||
        !skill ||
        !installed.exports.find((value) => value.id === selection.id)?.enabled
      )
        throw new SkillRegistryError("skillDisabled");
      if (skill.capabilities.some((capability) => !installed.grants.includes(capability)))
        throw new SkillRegistryError("approvalRequired");
      const pack = await this.bundles.read(installed.digest);
      if (pack.manifest.id !== installed.id || pack.manifest.version !== installed.version)
        throw new SkillRegistryError("unavailable");
      captured.push({ pack, id: selection.id, parameters: selection.parameters });
      if (!origins.some((value) => value.id === installed.id && value.version === installed.version))
        origins.push({
          id: installed.id,
          version: installed.version,
          digest: installed.digest,
          origin: installed.origin,
        });
    }
    const composition = composeSkills(captured, { ...authority, applicationVersion: this.applicationVersion });
    return this.registry.capture(
      {
        id,
        owner: ownerId,
        requestBinding: binding,
        registryRevision,
        createdAt: clock(this.now()),
        composition,
        origins,
      },
      request,
      registryRevision,
    );
  }
}
