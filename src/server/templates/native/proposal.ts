import type { CapturedPackageSource } from "../../../shared/packages/sources/snapshot.js";
import type { NativeThemeProposal } from "../../../shared/templates/native/contracts.js";
import type { BuildEngine } from "../../../shared/builds/engines.js";
import { TemplateSourceIndex, sourceRecord, sourcePathAt, sourceModuleEntry } from "../sources/index.js";

const text = (value: unknown, max = 160) =>
  typeof value === "string" && value.trim() && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : "";
const semver = (value: unknown) =>
  typeof value === "string" && /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/.test(value)
    ? value
    : "1.0.0";

/** Proposals read bounded plain metadata, never executable engine configuration or package scripts. */
export function nativeThemeProposal(
  source: CapturedPackageSource,
  root: string,
  engine: BuildEngine,
): NativeThemeProposal {
  const index = new TemplateSourceIndex(source),
    packagePath = sourcePathAt(root, "package.json"),
    metadata = index.has(root, "package.json") ? index.metadata(packagePath) : null,
    origin = source.descriptor.origin,
    fallback =
      root.split("/").at(-1) ||
      (origin.kind === "zip-upload" ? origin.name.replace(/\.zip$/i, "") : origin.repository.split("/").at(-1)!),
    name = text(metadata?.name) || fallback,
    slug = name
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 50)
      .replace(/\.+$/, ""),
    id = slug.length >= 3 && /^[a-z]/.test(slug) ? slug : "theme." + (slug || "imported"),
    ancestors: string[] = [];
  let directory = root;
  while (true) {
    ancestors.push(directory);
    if (!directory) break;
    directory = directory.split("/").slice(0, -1).join("/");
  }
  const rank = (path: string) => {
      const value = ancestors.indexOf(path.split("/").slice(0, -1).join("/"));
      return value < 0 ? ancestors.length : value;
    },
    licenseFiles = source.tree.files
      .filter(
        (file) =>
          /(?:^|\/)(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(file.path) &&
          file.bytes > 0 &&
          file.bytes <= 256 * 1024 &&
          rank(file.path) < ancestors.length,
      )
      .map((file) => file.path)
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "en"))
      .slice(0, 64),
    readme = source.tree.files
      .filter(
        (file) => /(?:^|\/)readme(?:\.(?:md|txt|markdown))?$/i.test(file.path) && rank(file.path) < ancestors.length,
      )
      .sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path, "en"))[0];
  let readmeText = "";
  let licenseText = "";
  if (licenseFiles[0]) {
    try {
      licenseText = source.tree.text(licenseFiles[0], 256 * 1024);
    } catch {
      index.issues.push({ path: licenseFiles[0], code: "metadataInvalid" });
    }
  }
  if (readme) {
    if (readme.bytes > 512 * 1024) index.issues.push({ path: readme.path, code: "metadataTooLarge" });
    else
      try {
        readmeText = source.tree.text(readme.path, 512 * 1024);
      } catch {
        index.issues.push({ path: readme.path, code: "metadataInvalid" });
      }
  }
  const dependencies: Record<string, string> = {};
  if (metadata?.dependencies !== undefined) {
    if (
      sourceRecord(metadata.dependencies) &&
      Object.keys(metadata.dependencies).length <= 128 &&
      Object.values(metadata.dependencies).every((value) => typeof value === "string")
    )
      for (const [key, value] of Object.entries(metadata.dependencies))
        Object.defineProperty(dependencies, key, { value, enumerable: true, configurable: true, writable: true });
    else index.issues.push({ path: packagePath, code: "metadataInvalid" });
  }
  const author = sourceRecord(metadata?.author) ? metadata.author.name : metadata?.author;
  const entry = sourceModuleEntry(index, root, metadata?.main) || "";
  return {
    settings: {
      schema: 1,
      id,
      version: semver(metadata?.version),
      name: { en: name },
      description: { en: text(metadata?.description, 2000) || name },
      publisher: text(author) || (origin.kind === "github" ? origin.repository.split("/").at(-2)! : ""),
      license: { expression: text(metadata?.license, 120), file: licenseFiles[0] || "" },
      readme: readme?.path ?? null,
      engine,
      entry: engine === "hexo" ? null : entry,
      dependencies,
    },
    licenseFiles,
    licenseText,
    readmeText,
    issues: index.issues,
  };
}
