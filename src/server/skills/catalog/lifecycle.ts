import type { SkillRegistryCommand, SkillRegistryStore, SkillBundleStore } from "../ports.js";
import { packageId, version, localId } from "../../../shared/skills/manifest/identity.js";
import { record } from "../../../shared/skills/manifest/primitives.js";
import { SkillRegistryError } from "../errors.js";
import { actor, clock, operation, requestHash, revision } from "./validation.js";
export class SkillLifecycle {
  constructor(
    private registry: SkillRegistryStore,
    private bundles: SkillBundleStore,
    private now: () => number,
  ) {}
  async change(kind: "activate" | "exports" | "remove", value: unknown, owner: unknown) {
    const input = record(value, [
        "operationId",
        "id",
        "version",
        "expectedRevision",
        ...(kind === "exports" ? ["exports"] : []),
      ]),
      id = packageId(input.id),
      packageVersion = version(input.version),
      operationId = operation(input.operationId),
      actorId = actor(owner),
      expectedRevision = revision(input.expectedRevision);
    let exports: { id: string; enabled: boolean }[] = [];
    if (kind === "exports") {
      if (!Array.isArray(input.exports) || input.exports.length > 64) throw new SkillRegistryError("invalidInput");
      exports = input.exports
        .map((value) => {
          const row = record(value, ["id", "enabled"]);
          if (typeof row.enabled !== "boolean") throw new SkillRegistryError("invalidInput");
          return { id: localId(row.id), enabled: row.enabled };
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (new Set(exports.map((value) => value.id)).size !== exports.length)
        throw new SkillRegistryError("invalidInput");
    }
    const command: SkillRegistryCommand =
        kind === "exports" ? { kind, id, version: packageVersion, exports } : { kind, id, version: packageVersion },
      request = requestHash({ ...command, expectedRevision });
    const replay = await this.registry.replay(actorId, operationId, request);
    if (replay) return replay;
    const installed = await this.registry.get(id, packageVersion);
    if (!installed || installed.removed) throw new SkillRegistryError("notInstalled");
    if (kind === "exports")
      for (const item of exports) {
        const skill = installed.manifest.skills.find((skill) => skill.id === item.id);
        if (!skill) throw new SkillRegistryError("invalidInput");
        if (item.enabled && skill.capabilities.some((capability) => !installed.grants.includes(capability)))
          throw new SkillRegistryError("approvalRequired");
      }
    if (kind === "activate") {
      const pack = await this.bundles.read(installed.digest);
      if (pack.manifest.id !== id || pack.manifest.version !== packageVersion)
        throw new SkillRegistryError("unavailable");
    }
    return this.registry.apply(command, {
      id: operationId,
      actor: actorId,
      expectedRevision,
      now: clock(this.now()),
      request,
    });
  }
}
