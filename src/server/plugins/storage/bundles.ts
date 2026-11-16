import { PACKAGE_LIMITS, type VerifiedPluginPackage } from "../../../shared/plugins/contracts.js";
import { parsePluginPackage, verifyPluginPackage } from "../../../shared/plugins/package.js";
import { canonicalPackageJson } from "../../../shared/plugins/validation.js";
import { FilePackageContent } from "../../packages/content-store.js";
import { PluginRegistryError } from "../errors.js";
import type { PluginBundleStore } from "../ports.js";

/** Theme interpretation remains separate from the shared immutable content storage. */
export class FilePluginBundles implements PluginBundleStore {
  private store: FilePackageContent<VerifiedPluginPackage>;
  constructor(root: string) {
    this.store = new FilePackageContent(root, {
      maxBytes: PACKAGE_LIMITS.jsonBytes,
      encode: async (value) =>
        new TextEncoder().encode(canonicalPackageJson((await verifyPluginPackage(value.package)).package)),
      decode: (bytes) => parsePluginPackage(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      digest: (value) => value.digest,
    });
  }
  async put(value: VerifiedPluginPackage): Promise<void> {
    const checked = await verifyPluginPackage(value.package);
    if (checked.digest !== value.digest) throw new PluginRegistryError("reviewChanged");
    try {
      await this.store.put(checked);
    } catch {
      throw new PluginRegistryError("packageUnavailable");
    }
  }
  async read(digest: string): Promise<VerifiedPluginPackage> {
    try {
      return await this.store.read(digest);
    } catch {
      throw new PluginRegistryError("packageUnavailable");
    }
  }
}
