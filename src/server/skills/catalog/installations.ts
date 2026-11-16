import type { VerifiedSkillPack } from "../../../shared/skills/contracts.js";
import type { SkillPackOrigin, SkillInstallReview, InstalledSkillPack } from "../../../shared/skills/registry.js";
import { skillOrigin } from "../../../shared/skills/registry-validation.js";
import { assertSkillCompatibility } from "../../../shared/skills/manifest.js";
import { record } from "../../../shared/skills/manifest/primitives.js";
import { freezeSkillValue } from "../../../shared/skills/resources.js";
import type { SkillBundleStore, SkillRegistryStore } from "../ports.js";
import { SkillRegistryError } from "../errors.js";
import { actor, clock, grants, operation, ownedPack, requestHash, revision, selectedExports } from "./validation.js";

export class SkillInstallations {
  constructor(
    private registry: SkillRegistryStore,
    private bundles: SkillBundleStore,
    private applicationVersion: string,
    private now: () => number,
    private validateArtwork?: (pack: VerifiedSkillPack) => Promise<void>,
  ) {}
  async review(input: VerifiedSkillPack, origin: unknown, selected: unknown): Promise<SkillInstallReview> {
    const pack = await ownedPack(input);
    assertSkillCompatibility(pack.manifest, this.applicationVersion);
    await this.validateArtwork?.(pack);
    return this.reviewPack(pack, skillOrigin(origin), selectedExports(selected, pack));
  }
  private async reviewPack(
    pack: VerifiedSkillPack,
    origin: SkillPackOrigin,
    selected: string[],
  ): Promise<SkillInstallReview> {
    const revision = await this.registry.revision(),
      { manifest } = pack,
      prior = await this.registry.active(manifest.id),
      existing = await this.registry.get(manifest.id, manifest.version);
    if (existing && existing.digest !== pack.digest) throw new SkillRegistryError("immutableVersion");
    const capabilities = [
      ...new Set(
        manifest.skills.filter((skill) => selected.includes(skill.id)).flatMap((skill) => [...skill.capabilities]),
      ),
    ].sort();
    const reviewHash = requestHash({ schema: 1, digest: pack.digest, origin, selected, revision, capabilities });
    return freezeSkillValue({
      digest: pack.digest,
      revision,
      reviewHash,
      manifest,
      origin,
      selected,
      capabilities,
      addedCapabilities: capabilities.filter((value) => !prior?.grants.includes(value)),
      activeVersion: prior?.version ?? null,
      installed: !!existing && !existing.removed,
      sourceChanged: !!prior && requestHash(prior.origin) !== requestHash(origin),
      byteLength: pack.byteLength,
      fileCount: pack.resources.length,
    });
  }
  async install(
    input: VerifiedSkillPack,
    source: unknown,
    value: unknown,
    owner: unknown,
  ): Promise<InstalledSkillPack> {
    const pack = await ownedPack(input),
      origin = skillOrigin(source),
      approval = record(value, ["id", "expectedRevision", "reviewHash", "selected", "capabilities"]);
    const selected = selectedExports(approval.selected, pack),
      capabilities = grants(approval.capabilities),
      actorId = actor(owner),
      id = operation(approval.id),
      expectedRevision = revision(approval.expectedRevision);
    const request = requestHash({
      kind: "install",
      digest: pack.digest,
      origin,
      selected,
      capabilities,
      reviewHash: approval.reviewHash,
      expectedRevision,
    });
    const replay = await this.registry.replay(actorId, id, request);
    if (replay) return replay;
    assertSkillCompatibility(pack.manifest, this.applicationVersion);
    const review = await this.reviewPack(pack, origin, selected);
    if (review.reviewHash !== approval.reviewHash) throw new SkillRegistryError("reviewChanged");
    if (review.revision !== expectedRevision) throw new SkillRegistryError("registryConflict");
    if (
      capabilities.length !== review.capabilities.length ||
      review.capabilities.some((item) => !capabilities.includes(item))
    )
      throw new SkillRegistryError("approvalRequired");
    await this.validateArtwork?.(pack);
    await this.bundles.put(pack);
    return this.registry.apply(
      {
        kind: "install",
        pack: {
          id: pack.manifest.id,
          version: pack.manifest.version,
          digest: pack.digest,
          manifest: pack.manifest,
          origin,
          grants: capabilities,
          exports: pack.manifest.skills.map((skill) => ({ id: skill.id, enabled: selected.includes(skill.id) })),
        },
      },
      { id, actor: actorId, expectedRevision, now: clock(this.now()), request },
    );
  }
}
