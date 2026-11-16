import type { SkillRegistryStore, SkillBundleStore } from "../ports.js";
import { packageId, version, localId } from "../../../shared/skills/manifest/identity.js";
import { skillDigest } from "../../../shared/skills/registry-validation.js";
import { SkillRegistryError } from "../errors.js";
import { SkillArtworkCache } from "./artwork-cache.js";

/** Inspection and export do not enable a pack or grant its workflow capabilities. */
export class SkillInspection {
  private readonly artworkCache = new SkillArtworkCache();
  constructor(
    private registry: SkillRegistryStore,
    private bundles: SkillBundleStore,
  ) {}
  async detail(id: unknown, selectedVersion: unknown) {
    const value = await this.registry.detail(packageId(id), version(selectedVersion));
    if (!value.package) throw new SkillRegistryError("notInstalled");
    return { ...value, package: value.package };
  }
  async export(id: unknown, selectedVersion: unknown) {
    const { package: installed } = await this.detail(id, selectedVersion);
    const value = await this.bundles.read(installed.digest);
    if (
      value.digest !== installed.digest ||
      value.manifest.id !== installed.id ||
      value.manifest.version !== installed.version
    )
      throw new SkillRegistryError("unavailable");
    return value;
  }
  async template(id: unknown, selectedVersion: unknown, exportId: unknown) {
    const pack = await this.export(id, selectedVersion);
    const entryId = localId(exportId);
    const skill = pack.manifest.skills.find((item) => item.id === entryId);
    if (!skill) throw new SkillRegistryError("notFound");
    return {
      kind: skill.template ? ("structure" as const) : ("instructions" as const),
      content: pack.text(skill.template || skill.instructions),
    };
  }
  async artwork(id: unknown, selectedVersion: unknown, digest: unknown, exportId: unknown) {
    const expected = skillDigest(digest),
      entryId = localId(exportId),
      { package: installed } = await this.detail(id, selectedVersion);
    if (installed.digest !== expected) throw new SkillRegistryError("immutableVersion");
    const skill = installed.manifest.skills.find((item) => item.id === entryId);
    const path = skill?.cover?.path || skill?.previews?.[0];
    if (!path) throw new SkillRegistryError("notFound");
    // Check current installation metadata before every cache read, including conditional requests.
    return this.artworkCache.read(JSON.stringify([expected, path]), async () => {
      const pack = await this.bundles.read(installed.digest),
        original = pack.manifest.skills.find((item) => item.id === entryId);
      if (
        pack.digest !== installed.digest ||
        pack.manifest.id !== installed.id ||
        pack.manifest.version !== installed.version ||
        (original?.cover?.path || original?.previews?.[0]) !== path
      )
        throw new SkillRegistryError("unavailable");
      return pack.read(path);
    });
  }
}
