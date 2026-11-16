import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import { sourcePath } from "../../../shared/packages/sources/paths.js";
import { verifyPortableTemplateTree } from "../../../shared/templates/portable/bundle.js";
import {
  validatePortableTemplateIndex,
  validatePortableTemplateManifest,
} from "../../../shared/templates/portable/manifest.js";
import { templateAssert } from "../../../shared/templates/portable/errors.js";
import { DEFAULT_TEMPLATE_RESOURCE_POLICY } from "../../../shared/templates/portable/contracts.js";
import { templateJson } from "../../../shared/templates/portable/validation.js";

/** The original source keeps unrelated repository files; installation verifies every declared template resource. */
export async function capturedTemplateLibrary(source: CapturedPackageSource, root: string) {
  const prefix = root === "" ? "" : sourcePath(root) + "/",
    policy = DEFAULT_TEMPLATE_RESOURCE_POLICY;
  templateAssert(source.tree.has(prefix + "panda-templates.json"), "resourceMissing");
  const indexRaw = source.tree.read(prefix + "panda-templates.json");
  templateAssert(indexRaw.length <= policy.manifestBytes, "packageTooLarge");
  const index = validatePortableTemplateIndex(templateJson(indexRaw)),
    resources = new Map<string, Uint8Array>();
  for (const entry of index.entries) {
    templateAssert(source.tree.has(prefix + entry.manifest), "resourceMissing");
    const raw = source.tree.read(prefix + entry.manifest);
    templateAssert(raw.length <= policy.manifestBytes, "packageTooLarge");
    const manifest = validatePortableTemplateManifest(templateJson(raw)),
      directory = entry.manifest.includes("/") ? entry.manifest.slice(0, entry.manifest.lastIndexOf("/") + 1) : "";
    resources.set(entry.manifest, raw);
    for (const file of manifest.files) {
      const path = directory + file.path;
      templateAssert(source.tree.has(prefix + path), "resourceMissing");
      resources.set(path, source.tree.read(prefix + path));
    }
  }
  return verifyPortableTemplateTree(
    index,
    [...resources].map(([path, bytes]) => ({ path, bytes })),
    policy,
  );
}
