import type { SkillBundleStore, SkillRegistryStore } from "../ports.js";
import type { VerifiedSkillPack } from "../../../shared/skills/contracts.js";
import type { SkillCompositionAuthority } from "../../../shared/skills/composition.js";
import { SkillInstallations } from "./installations.js";
import { SkillLifecycle } from "./lifecycle.js";
import { InstalledSkillCapture } from "./capture.js";
import { SkillInspection } from "./inspection.js";
import { actor, operation } from "./validation.js";
import { SkillRegistryError } from "../errors.js";

/** Use cases share storage ports, while installation, lifecycle and task capture remain independent. */
export class SkillCatalog {
  private installations: SkillInstallations;
  private lifecycle: SkillLifecycle;
  private captures: InstalledSkillCapture;
  private inspection: SkillInspection;
  constructor(
    private registry: SkillRegistryStore,
    bundles: SkillBundleStore,
    applicationVersion: string,
    now: () => number = Date.now,
    validateArtwork?: (pack: VerifiedSkillPack) => Promise<void>,
  ) {
    this.installations = new SkillInstallations(registry, bundles, applicationVersion, now, validateArtwork);
    this.lifecycle = new SkillLifecycle(registry, bundles, now);
    this.captures = new InstalledSkillCapture(registry, bundles, applicationVersion, now);
    this.inspection = new SkillInspection(registry, bundles);
  }
  async list(cursor?: string, limit?: number, activeOnly = false) {
    return this.registry.list(cursor, limit, activeOnly);
  }
  async audit(after?: number, limit?: number) {
    return this.registry.audit(after, limit);
  }
  detail(id: unknown, version: unknown) {
    return this.inspection.detail(id, version);
  }
  export(id: unknown, version: unknown) {
    return this.inspection.export(id, version);
  }
  template(id: unknown, version: unknown, exportId: unknown) {
    return this.inspection.template(id, version, exportId);
  }
  artwork(id: unknown, version: unknown, digest: unknown, exportId: unknown) {
    return this.inspection.artwork(id, version, digest, exportId);
  }
  review(pack: VerifiedSkillPack, origin: unknown, selected: unknown) {
    return this.installations.review(pack, origin, selected);
  }
  install(pack: VerifiedSkillPack, origin: unknown, approval: unknown, actor: unknown) {
    return this.installations.install(pack, origin, approval, actor);
  }
  activate(value: unknown, actor: unknown) {
    return this.lifecycle.change("activate", value, actor);
  }
  setExports(value: unknown, actor: unknown) {
    return this.lifecycle.change("exports", value, actor);
  }
  remove(value: unknown, actor: unknown) {
    return this.lifecycle.change("remove", value, actor);
  }
  capture(value: unknown, actor: unknown, authority: Omit<SkillCompositionAuthority, "applicationVersion">) {
    return this.captures.create(value, actor, authority);
  }
  async getCapture(id: unknown, owner: unknown) {
    const value = await this.registry.captureById(actor(owner), operation(id));
    if (!value) throw new SkillRegistryError("notFound");
    return value;
  }
}
