import type { VerifiedSkillPack } from "../../../shared/skills/contracts.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { SkillRegistryError } from "../errors.js";
import type { SkillBundleStore } from "../ports.js";
import { decodeSkillBundle, encodeSkillBundle, SKILL_BUNDLE_BYTES } from "./codec.js";

export class FileSkillBundles implements SkillBundleStore {
  private store: FilePackageContent<VerifiedSkillPack>;
  constructor(root: string) {
    this.store = new FilePackageContent(root, {
      maxBytes: SKILL_BUNDLE_BYTES,
      encode: async (value) => encodeSkillBundle(value),
      decode: decodeSkillBundle,
      digest: (value) => value.digest,
    });
  }
  async put(value: VerifiedSkillPack): Promise<void> {
    try {
      await this.store.put(value);
    } catch {
      throw new SkillRegistryError("unavailable");
    }
  }
  async read(digest: string): Promise<VerifiedSkillPack> {
    try {
      return await this.store.read(digest);
    } catch {
      throw new SkillRegistryError("unavailable");
    }
  }
}
